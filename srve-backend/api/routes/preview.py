from __future__ import annotations

import base64
import hashlib
import time
from pathlib import Path
import subprocess
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from core.midi_parser import MidiData, parse_midi
from core.project import Layer, Project, SourceVideo
from core.renderer import RenderEngine
from utils.ffmpeg_path import get_ffmpeg_path
from utils.ffmpeg_utils import generate_effect_filters
from utils.gpu_accel import detect_gpu_capabilities, get_hw_encode_args
from utils.math_utils import calculate_grid_cell

router = APIRouter(prefix="/preview", tags=["preview"])


@router.get("/frame")
def get_preview_frame(t: float) -> dict[str, str]:
    raise HTTPException(status_code=501, detail="Not implemented")


class CompositeFrameRequest(BaseModel):
    timestamp_ms: int
    project: Project
    quality: Literal["low", "medium"] = "medium"
    midi_data: MidiData | None = None


class ActiveLayerInfo(BaseModel):
    layer_id: str
    clip_index: int
    source_frame_ms: int


class CompositeFrameResponse(BaseModel):
    image_base64: str
    active_layers: list[ActiveLayerInfo]


def _preview_resolution(
    output_resolution: tuple[int, int],
    quality: Literal["low", "medium"],
) -> tuple[int, int]:
    out_w, out_h = output_resolution
    if out_w <= 0 or out_h <= 0:
        out_w, out_h = 1920, 1080
    target_w = 640 if quality == "low" else 960
    ratio = out_h / float(out_w)
    target_h = int(round(target_w * ratio))
    if target_h <= 0:
        target_h = 360
    return target_w, target_h


def _project_digest(project: Project) -> str:
    if hasattr(project, "model_dump_json"):
        payload = project.model_dump_json()
    else:
        payload = project.json()
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


@router.post("/composite-frame", response_model=CompositeFrameResponse)
def composite_frame(payload: CompositeFrameRequest, request: Request) -> CompositeFrameResponse:
    timestamp_ms = int(payload.timestamp_ms)
    if timestamp_ms < 0:
        timestamp_ms = 0

    project = payload.project

    midi_data = payload.midi_data
    if midi_data is None:
        midi_path = project.midi_file_path
        if not midi_path:
            raise HTTPException(status_code=400, detail="No MIDI data provided")
        try:
            midi_data = parse_midi(str(midi_path))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    engine = RenderEngine(project, midi_data)
    clips_by_layer = engine.generate_all_clips()

    out_w, out_h = project.settings.output_resolution
    preview_w, preview_h = _preview_resolution((out_w, out_h), payload.quality)

    enabled_layers = sorted(
        [l for l in project.layers if l.enabled],
        key=lambda l: int(getattr(l, "order", 0)),
    )

    video_by_id = {v.id: v for v in project.source_videos}

    active_layers: list[ActiveLayerInfo] = []
    overlays: list[tuple[SourceVideo, Layer, int, int, int, int, float, str, str, int]] = []

    for layer in enabled_layers:
        clips = clips_by_layer.get(layer.id, [])
        if not clips:
            continue
        active = None
        for clip in clips:
            start = int(getattr(clip, "start_ms", 0))
            dur = int(getattr(clip, "duration_ms", 0))
            if dur <= 0:
                continue
            if start <= timestamp_ms < start + dur:
                active = clip
                break
        if active is None:
            continue

        source = video_by_id.get(layer.source_video_id or "")
        if source is None:
            continue

        offset_ms = timestamp_ms - int(getattr(active, "start_ms", 0))
        if offset_ms < 0:
            offset_ms = 0

        source_frame_ms = int(getattr(active, "source_start_ms", 0)) + offset_ms
        if source.duration_ms > 0:
            source_frame_ms = max(0, min(source_frame_ms, source.duration_ms - 1))

        grid_size = project.settings.global_grid
        if not layer.use_global_grid and layer.custom_grid is not None:
            grid_size = layer.custom_grid
        cell = calculate_grid_cell((preview_w, preview_h), grid_size, layer.grid_position)
        cell_x = int(cell.get("x") or 0)
        cell_y = int(cell.get("y") or 0)
        cell_w = int(cell.get("width") or preview_w)
        cell_h = int(cell.get("height") or preview_h)
        if cell_w <= 0:
            cell_w = preview_w
        if cell_h <= 0:
            cell_h = preview_h

        velocity = int(getattr(active, "velocity", 127))
        velocity = max(0, min(velocity, 127))
        alpha = velocity / 127.0

        flip_state = str(getattr(active, "flip_state", "normal"))
        effects = generate_effect_filters(layer)

        active_layers.append(
            ActiveLayerInfo(
                layer_id=str(layer.id),
                clip_index=int(getattr(active, "clip_index", 0)),
                source_frame_ms=int(source_frame_ms),
            )
        )
        overlays.append(
            (
                source,
                layer,
                cell_x,
                cell_y,
                cell_w,
                cell_h,
                alpha,
                flip_state,
                effects,
                int(source_frame_ms),
            )
        )

    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    previews_dir = temp_dir / "preview_frames"
    previews_dir.mkdir(parents=True, exist_ok=True)

    digest = hashlib.sha1(
        f"{_project_digest(project)}|{timestamp_ms}|{payload.quality}".encode("utf-8")
    ).hexdigest()
    cache_path = previews_dir / f"{digest}.png"

    if cache_path.exists():
        try:
            raw = cache_path.read_bytes()
            return CompositeFrameResponse(
                image_base64=base64.b64encode(raw).decode("ascii"),
                active_layers=active_layers,
            )
        except Exception:
            pass

    args: list[str] = ["-v", "error", "-y"]

    base_is_chorus = False
    chorus_frame_ms = 0
    chorus_path = project.chorus_video_path
    if chorus_path and timestamp_ms >= int(project.chorus_offset_ms or 0):
        chorus_frame_ms = timestamp_ms - int(project.chorus_offset_ms or 0)
        if chorus_frame_ms < 0:
            chorus_frame_ms = 0
        args.extend(["-ss", f"{chorus_frame_ms / 1000.0:.6f}", "-i", str(chorus_path)])
        base_is_chorus = True
    else:
        args.extend(["-f", "lavfi", "-i", f"color=c=black@0.0:s={preview_w}x{preview_h}"])

    for (source, _layer, _x, _y, _cw, _ch, _alpha, _flip, _effects, source_frame_ms) in overlays:
        args.extend(["-ss", f"{source_frame_ms / 1000.0:.6f}", "-i", str(source.path)])

    fg_parts: list[str] = []
    if base_is_chorus:
        fg_parts.append(
            f"[0:v]setpts=PTS-STARTPTS,"
            f"scale={preview_w}:{preview_h}:force_original_aspect_ratio=decrease,"
            f"pad={preview_w}:{preview_h}:(ow-iw)/2:(oh-ih)/2,format=rgba[base]"
        )
    else:
        fg_parts.append("[0:v]setpts=PTS-STARTPTS,format=rgba[base]")

    current = "base"
    for idx, (_source, layer, x, y, cell_w, cell_h, alpha, flip_state, effects, _source_frame_ms) in enumerate(overlays):
        input_idx = idx + 1
        chain: list[str] = [
            f"[{input_idx}:v]scale={cell_w}:{cell_h}:force_original_aspect_ratio=decrease",
            f"pad={cell_w}:{cell_h}:(ow-iw)/2:(oh-ih)/2",
            "setpts=PTS-STARTPTS",
        ]
        if flip_state in {"h_flip", "hv_flip"}:
            chain.append("hflip")
        if flip_state in {"v_flip", "hv_flip"}:
            chain.append("vflip")
        chain.append("format=rgba")
        if bool(getattr(layer, "velocity_opacity", True)):
            chain.append(f"colorchannelmixer=aa={alpha:.6f}")
        if effects:
            chain.append(effects)
        layer_label = f"lay{idx}"
        fg_parts.append(",".join(chain) + f"[{layer_label}]")
        out = f"o{idx}"
        fg_parts.append(f"[{current}][{layer_label}]overlay={x}:{y}:format=auto[{out}]")
        current = out

    filter_graph = ";".join(fg_parts)
    args.extend(["-filter_complex", filter_graph])
    args.extend(["-map", f"[{current}]", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"])

    try:
        result = subprocess.run(
            [get_ffmpeg_path(), *args],
            capture_output=True,
            check=False,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if result.returncode != 0:
        msg = (result.stderr or result.stdout or b"").decode("utf-8", errors="replace").strip()
        if not msg:
            msg = f"ffmpeg exited with code {result.returncode}"
        raise HTTPException(status_code=400, detail=msg)

    raw = result.stdout or b""
    if not raw:
        raise HTTPException(status_code=400, detail="FFmpeg returned no frame")

    try:
        cache_path.write_bytes(raw)
    except Exception:
        pass

    return CompositeFrameResponse(
        image_base64=base64.b64encode(raw).decode("ascii"),
        active_layers=active_layers,
    )


class RenderSegmentRequest(BaseModel):
    start_ms: int
    duration_ms: int = 5000
    quality: Literal["fast", "high"] = "fast"
    project: Project
    midi_data: MidiData | None = None


class RenderSegmentResponse(BaseModel):
    video_url: str
    duration_ms: int
    width: int
    height: int
    fps: int


def _segment_resolution(
    output_resolution: tuple[int, int],
    quality: Literal["fast", "high"],
) -> tuple[int, int, int]:
    out_w, out_h = output_resolution
    if out_w <= 0 or out_h <= 0:
        out_w, out_h = 1920, 1080
    if quality == "fast":
        target_w, fps = 960, 24
    else:
        target_w, fps = 1280, 30
    ratio = out_h / float(out_w)
    target_h = int(round(target_w * ratio))
    if target_h % 2 == 1:
        target_h += 1
    if target_w % 2 == 1:
        target_w += 1
    return target_w, target_h, fps


@router.post("/render-segment", response_model=RenderSegmentResponse)
def render_segment(payload: RenderSegmentRequest, request: Request) -> RenderSegmentResponse:
    start_ms = max(0, int(payload.start_ms))
    duration_ms = max(500, min(30000, int(payload.duration_ms)))
    end_ms = start_ms + duration_ms

    project = payload.project
    midi_data = payload.midi_data
    if midi_data is None:
        midi_path = project.midi_file_path
        if not midi_path:
            raise HTTPException(status_code=400, detail="No MIDI data provided")
        try:
            midi_data = parse_midi(str(midi_path))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    engine = RenderEngine(project, midi_data)
    clips_by_layer = engine.generate_all_clips()

    out_w, out_h = project.settings.output_resolution
    preview_w, preview_h, fps = _segment_resolution((out_w, out_h), payload.quality)

    enabled_layers = sorted(
        [l for l in project.layers if l.enabled],
        key=lambda l: int(getattr(l, "order", 0)),
    )
    video_by_id = {v.id: v for v in project.source_videos}

    layer_clips: list[tuple[Layer, SourceVideo, list]] = []
    for layer in enabled_layers:
        clips = clips_by_layer.get(layer.id, [])
        source = video_by_id.get(layer.source_video_id or "")
        if not source:
            continue
        relevant = []
        for clip in clips:
            clip_start = int(getattr(clip, "start_ms", 0))
            clip_dur = int(getattr(clip, "duration_ms", 0))
            clip_end = clip_start + clip_dur
            if clip_end > start_ms and clip_start < end_ms:
                relevant.append(clip)
        if relevant:
            layer_clips.append((layer, source, relevant))

    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    segments_dir = temp_dir / "preview_segments"
    segments_dir.mkdir(parents=True, exist_ok=True)

    digest = hashlib.sha1(
        f"{_project_digest(project)}|{start_ms}|{duration_ms}|{payload.quality}".encode()
    ).hexdigest()[:16]
    output_path = segments_dir / f"seg_{digest}_{int(time.time())}.mp4"

    args: list[str] = ["-v", "warning", "-y"]

    chorus_path = project.chorus_video_path
    chorus_offset = int(project.chorus_offset_ms or 0)
    use_chorus = bool(chorus_path and end_ms > chorus_offset)

    if use_chorus:
        chorus_start_s = max(0, start_ms - chorus_offset) / 1000.0
        args.extend(["-ss", f"{chorus_start_s:.6f}", "-t", f"{duration_ms / 1000.0:.6f}", "-i", str(chorus_path)])
    else:
        args.extend(["-f", "lavfi", "-t", f"{duration_ms / 1000.0:.6f}", "-i", f"color=c=black:s={preview_w}x{preview_h}:r={fps}"])

    input_map: dict[str, int] = {}
    input_idx = 1
    for layer, source, _ in layer_clips:
        key = source.path
        if key not in input_map:
            args.extend(["-stream_loop", "-1", "-i", str(source.path)])
            input_map[key] = input_idx
            input_idx += 1

    fg_parts: list[str] = []

    if use_chorus:
        fg_parts.append(
            f"[0:v]setpts=PTS-STARTPTS,"
            f"scale={preview_w}:{preview_h}:force_original_aspect_ratio=decrease,"
            f"pad={preview_w}:{preview_h}:(ow-iw)/2:(oh-ih)/2,"
            f"fps={fps},format=rgba[base]"
        )
    else:
        fg_parts.append(f"[0:v]fps={fps},format=rgba[base]")

    current = "base"
    overlay_idx = 0

    for layer, source, clips in layer_clips:
        src_input = input_map[source.path]
        grid_size = project.settings.global_grid
        if not layer.use_global_grid and layer.custom_grid is not None:
            grid_size = layer.custom_grid
        cell = calculate_grid_cell((preview_w, preview_h), grid_size, layer.grid_position)
        cell_x = int(cell.get("x") or 0)
        cell_y = int(cell.get("y") or 0)
        cell_w = int(cell.get("width") or preview_w)
        cell_h = int(cell.get("height") or preview_h)
        if cell_w <= 0:
            cell_w = preview_w
        if cell_h <= 0:
            cell_h = preview_h

        effects = generate_effect_filters(layer)

        enable_parts: list[str] = []
        for clip in clips:
            clip_start = int(getattr(clip, "start_ms", 0))
            clip_dur = int(getattr(clip, "duration_ms", 0))
            clip_end = clip_start + clip_dur
            vis_start = max(clip_start, start_ms) - start_ms
            vis_end = min(clip_end, end_ms) - start_ms
            if vis_end > vis_start:
                enable_parts.append(f"between(t,{vis_start / 1000.0:.6f},{vis_end / 1000.0:.6f})")

        if not enable_parts:
            continue

        enable_expr = "+".join(enable_parts)

        trim_chains: list[str] = []
        for ci, clip in enumerate(clips):
            clip_start = int(getattr(clip, "start_ms", 0))
            clip_dur = int(getattr(clip, "duration_ms", 0))
            source_start_ms = int(getattr(clip, "source_start_ms", 0))
            velocity = max(0, min(127, int(getattr(clip, "velocity", 127))))
            alpha = velocity / 127.0
            flip_state = str(getattr(clip, "flip_state", "normal"))

            rel_start = (clip_start - start_ms) / 1000.0
            src_start_s = source_start_ms / 1000.0
            dur_s = clip_dur / 1000.0

            label = f"l{overlay_idx}c{ci}"
            chain = [
                f"[{src_input}:v]trim=start={src_start_s:.6f}:duration={dur_s:.6f}",
                "setpts=PTS-STARTPTS",
                f"scale={cell_w}:{cell_h}:force_original_aspect_ratio=decrease",
                f"pad={cell_w}:{cell_h}:(ow-iw)/2:(oh-ih)/2",
                f"fps={fps}",
            ]
            if flip_state in {"h_flip", "hv_flip"}:
                chain.append("hflip")
            if flip_state in {"v_flip", "hv_flip"}:
                chain.append("vflip")
            chain.append("format=rgba")
            if bool(getattr(layer, "velocity_opacity", True)):
                chain.append(f"colorchannelmixer=aa={alpha:.6f}")
            if effects:
                chain.append(effects)
            chain.append(f"tpad=start_duration={max(0, rel_start):.6f}:start_mode=clone")
            trim_chains.append(",".join(chain) + f"[{label}]")

        if len(trim_chains) == 1:
            fg_parts.append(trim_chains[0])
            layer_out = f"l{overlay_idx}c0"
        else:
            for tc in trim_chains:
                fg_parts.append(tc)
            concat_inputs = "".join(f"[l{overlay_idx}c{i}]" for i in range(len(trim_chains)))
            layer_out = f"layer{overlay_idx}"
            fg_parts.append(f"{concat_inputs}concat=n={len(trim_chains)}:v=1:a=0[{layer_out}]")

        out_label = f"o{overlay_idx}"
        fg_parts.append(
            f"[{current}][{layer_out}]overlay={cell_x}:{cell_y}:format=auto:enable='{enable_expr}'[{out_label}]"
        )
        current = out_label
        overlay_idx += 1

    dur_s = duration_ms / 1000.0
    fg_parts.append(f"[{current}]trim=duration={dur_s:.6f},setpts=PTS-STARTPTS,format=yuv420p[out]")

    filter_graph = ";".join(fg_parts)
    args.extend(["-filter_complex", filter_graph])
    args.extend(["-map", "[out]", "-an"])

    caps = detect_gpu_capabilities()
    enc_quality = "low" if payload.quality == "fast" else "medium"
    encode_args = get_hw_encode_args("h264", enc_quality, use_hw=caps.has_nvenc_h264)
    args.extend(encode_args)
    args.extend(["-pix_fmt", "yuv420p", "-movflags", "+faststart"])
    args.append(str(output_path))

    try:
        result = subprocess.run(
            [get_ffmpeg_path(), *args],
            capture_output=True,
            check=False,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="Preview render timed out") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if result.returncode != 0:
        msg = (result.stderr or result.stdout or b"").decode("utf-8", errors="replace").strip()
        if not msg:
            msg = f"ffmpeg exited with code {result.returncode}"
        raise HTTPException(status_code=400, detail=msg)

    if not output_path.exists():
        raise HTTPException(status_code=500, detail="Segment file not created")

    return RenderSegmentResponse(
        video_url=f"/preview/segments/{output_path.name}",
        duration_ms=duration_ms,
        width=preview_w,
        height=preview_h,
        fps=fps,
    )


@router.get("/segments/{filename}")
def serve_segment(filename: str, request: Request):
    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    segments_dir = temp_dir / "preview_segments"
    file_path = segments_dir / filename
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Segment not found")
    if not str(file_path.resolve()).startswith(str(segments_dir.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    return FileResponse(file_path, media_type="video/mp4")
