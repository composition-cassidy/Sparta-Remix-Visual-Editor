from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from core.midi_parser import MidiData
from core.project import FlipMode, Layer, Project, SourceVideo
from utils.ffmpeg_path import get_ffmpeg_path
from utils.ffmpeg_utils import generate_layer_filter_chain
from utils.gpu_accel import get_optimized_output_args
from utils.math_utils import calculate_grid_cell


class ClipPlacement(BaseModel):
    start_ms: int
    duration_ms: int
    source_start_ms: int
    velocity: int = Field(ge=0, le=127)
    flip_state: Literal["normal", "h_flip", "v_flip", "hv_flip"] = "normal"
    clip_index: int


class RenderEngine:
    def __init__(self, project: Project, midi_data: MidiData) -> None:
        self.project = project
        self.midi_data = midi_data
        self._video_by_id: dict[str, SourceVideo] = {
            v.id: v for v in project.source_videos
        }

    def generate_ffmpeg_command(self, output_path: str) -> list[str]:
        project = self.project
        out_res = project.settings.output_resolution
        out_w, out_h = out_res

        clips_by_layer = self.generate_all_clips()

        enabled_layers = sorted(
            [l for l in project.layers if l.enabled],
            key=lambda l: int(getattr(l, "order", 0)),
        )

        base_dir = Path(__file__).resolve().parent.parent
        temp_dir = base_dir / "temp" / "render_layers"
        temp_dir.mkdir(parents=True, exist_ok=True)

        plan: list[str] = []

        layer_outputs: list[str] = []
        for layer in enabled_layers:
            video = self._video_by_id.get(layer.source_video_id or "")
            if video is None:
                continue

            clips = clips_by_layer.get(layer.id, [])
            if not clips:
                continue

            grid_size = project.settings.global_grid
            if not layer.use_global_grid and layer.custom_grid is not None:
                grid_size = layer.custom_grid

            cell = calculate_grid_cell(out_res, grid_size, layer.grid_position)

            filter_graph = generate_layer_filter_chain(
                layer=layer,
                clips=clips,
                source=video,
                cell=cell,
                output_resolution=out_res,
            )
            if not filter_graph:
                continue

            layer_out = str(temp_dir / f"layer_{layer.id}.mp4")
            layer_outputs.append(layer_out)

            cmd: list[str] = [get_ffmpeg_path(), "-i", video.path]
            cmd.extend(["-filter_complex", filter_graph])
            cmd.extend(["-map", "[v]"])
            cmd.extend(["-an"])
            cmd.extend(
                get_optimized_output_args(
                    layer_out,
                    codec=project.settings.output_codec,
                    quality="high",
                    audio_bitrate=project.settings.output_audio_bitrate,
                    use_hw=True,
                )
            )

            if plan:
                plan.append("--next")
            plan.extend(cmd)

        if plan:
            plan.append("--next")

        if not layer_outputs:
            blank = f"color=c=black@0.0:s={out_w}x{out_h}:d=1,format=rgba"
            final_cmd: list[str] = [get_ffmpeg_path(), "-f", "lavfi", "-i", blank]
            final_cmd.extend(["-map", "0:v"])
            final_cmd.extend(["-an"])
            final_cmd.extend(
                get_optimized_output_args(
                    output_path,
                    codec=project.settings.output_codec,
                    quality="high",
                    audio_bitrate=project.settings.output_audio_bitrate,
                    use_hw=True,
                )
            )
            plan.extend(final_cmd)
            return plan

        final_cmd: list[str] = [get_ffmpeg_path()]

        chorus_index: int | None = None
        layer_start_index = 0

        if project.chorus_video_path:
            chorus_index = 0
            layer_start_index = 1
            chorus_offset_sec = max(0.0, float(project.chorus_offset_ms or 0) / 1000.0)
            if chorus_offset_sec > 0:
                final_cmd.extend(["-itsoffset", f"{chorus_offset_sec:.6f}"])
            final_cmd.extend(["-i", project.chorus_video_path])

        for p in layer_outputs:
            final_cmd.extend(["-i", p])

        bgm_index: int | None = None
        if project.bgm_path:
            bgm_offset_sec = max(0.0, float(project.bgm_offset_ms or 0) / 1000.0)
            if bgm_offset_sec > 0:
                final_cmd.extend(["-itsoffset", f"{bgm_offset_sec:.6f}"])
            bgm_index = layer_start_index + len(layer_outputs)
            final_cmd.extend(["-i", project.bgm_path])

        fg_parts: list[str] = []

        if chorus_index is not None:
            fg_parts.append(
                f"[{chorus_index}:v]"
                f"scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,"
                f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2,"
                f"format=rgba[base]"
            )
        else:
            fg_parts.append(f"color=c=black@0.0:s={out_w}x{out_h},format=rgba[base]")

        current = "base"
        for idx in range(len(layer_outputs)):
            input_idx = layer_start_index + idx
            nxt = f"l{idx}"
            out = f"o{idx}"
            fg_parts.append(f"[{input_idx}:v]format=rgba[{nxt}]")
            fg_parts.append(f"[{current}][{nxt}]overlay=0:0:format=auto[{out}]")
            current = out

        final_graph = ";".join(fg_parts)

        final_cmd.extend(["-filter_complex", final_graph])
        final_cmd.extend(["-map", f"[{current}]"])

        if bgm_index is not None:
            final_cmd.extend(["-map", f"{bgm_index}:a:0?"])
        elif chorus_index is not None:
            final_cmd.extend(["-map", f"{chorus_index}:a:0?"])
        else:
            final_cmd.extend(["-an"])

        final_cmd.extend(
            get_optimized_output_args(
                output_path,
                codec=project.settings.output_codec,
                quality="high",
                audio_bitrate=project.settings.output_audio_bitrate,
                use_hw=True,
            )
        )

        plan.extend(final_cmd)
        return plan

    def _get_bpm(self) -> float:
        if self.project.bpm is not None and self.project.bpm > 0:
            return self.project.bpm
        return self.midi_data.bpm if self.midi_data.bpm > 0 else 120.0

    def _note_length_to_ms(self, mode: str) -> int:
        bpm = self._get_bpm()
        beat_ms = 60000.0 / bpm

        if mode == "4th":
            return int(beat_ms)
        elif mode == "8th":
            return int(beat_ms / 2)
        elif mode == "16th":
            return int(beat_ms / 4)
        elif mode == "32nd":
            return int(beat_ms / 8)
        return 0

    def calculate_flip_state(
        self, flip_mode: FlipMode, clip_index: int
    ) -> Literal["normal", "h_flip", "v_flip", "hv_flip"]:
        if flip_mode == FlipMode.NONE:
            return "normal"

        if flip_mode == FlipMode.ALTERNATING:
            return "normal" if clip_index % 2 == 0 else "h_flip"

        if flip_mode == FlipMode.ROTATION_CW:
            states: list[Literal["normal", "h_flip", "v_flip", "hv_flip"]] = [
                "normal",
                "h_flip",
                "hv_flip",
                "v_flip",
            ]
            return states[clip_index % 4]

        if flip_mode == FlipMode.ROTATION_CCW:
            states_ccw: list[Literal["normal", "h_flip", "v_flip", "hv_flip"]] = [
                "normal",
                "v_flip",
                "hv_flip",
                "h_flip",
            ]
            return states_ccw[clip_index % 4]

        return "normal"

    def generate_clip_list(self, layer: Layer) -> list[ClipPlacement]:
        notes = self.midi_data.channels.get(layer.midi_channel, [])
        if not notes:
            return []

        video = self._video_by_id.get(layer.source_video_id or "")
        if video is None:
            return []

        clip_settings = layer.clip_settings
        in_point_ms = max(0, clip_settings.in_point_ms)
        out_point_ms = clip_settings.out_point_ms
        if out_point_ms < 0:
            out_point_ms = video.duration_ms
        out_point_ms = min(out_point_ms, video.duration_ms)

        usable_duration_ms = max(0, out_point_ms - in_point_ms)
        if usable_duration_ms == 0:
            return []

        loop_mode = clip_settings.loop_mode

        clips: list[ClipPlacement] = []
        source_cursor_ms = in_point_ms

        for clip_index, note in enumerate(notes):
            if layer.note_length_mode == "midi":
                duration_ms = note.duration_ms
            else:
                duration_ms = self._note_length_to_ms(layer.note_length_mode)

            if duration_ms <= 0:
                duration_ms = 100

            source_start_ms = source_cursor_ms

            if loop_mode == "freeze":
                if source_start_ms >= out_point_ms:
                    source_start_ms = out_point_ms - 1
                    if source_start_ms < in_point_ms:
                        source_start_ms = in_point_ms
            elif loop_mode == "continue":
                pass
            elif loop_mode == "crossfade":
                if source_start_ms >= out_point_ms:
                    source_start_ms = (
                        in_point_ms + (source_start_ms - in_point_ms) % usable_duration_ms
                    )

            flip_state = self.calculate_flip_state(layer.flip_mode, clip_index)

            clips.append(
                ClipPlacement(
                    start_ms=note.start_ms,
                    duration_ms=duration_ms,
                    source_start_ms=source_start_ms,
                    velocity=note.velocity,
                    flip_state=flip_state,
                    clip_index=clip_index,
                )
            )

            source_cursor_ms += duration_ms

        return clips

    def generate_all_clips(self) -> dict[str, list[ClipPlacement]]:
        result: dict[str, list[ClipPlacement]] = {}

        for layer in self.project.layers:
            if not layer.enabled:
                continue
            clips = self.generate_clip_list(layer)
            result[layer.id] = clips

        return result


class Renderer:
    def __init__(self, temp_dir: str) -> None:
        self.temp_dir = temp_dir

    def render(self, project: Project, output_path: str) -> None:
        raise NotImplementedError()
