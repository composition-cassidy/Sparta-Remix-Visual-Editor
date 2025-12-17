from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Sequence

from utils.ffmpeg_path import get_ffmpeg_path, get_ffprobe_path
from utils.gpu_accel import (
    detect_gpu_capabilities,
    get_hw_decode_args,
    get_hw_encode_args,
    get_thread_args,
)

from core.project import Layer, SourceVideo

if TYPE_CHECKING:
    from core.renderer import ClipPlacement


def run_ffmpeg(
    args: Sequence[str],
    priority: Literal["low", "normal", "high"] = "normal",
) -> subprocess.CompletedProcess[str]:
    """Run FFmpeg with optional process priority."""
    cmd = [get_ffmpeg_path(), *args]

    # Set process priority on Windows
    creationflags = 0
    if os.name == "nt":
        if priority == "low":
            creationflags = subprocess.BELOW_NORMAL_PRIORITY_CLASS
        elif priority == "high":
            creationflags = subprocess.ABOVE_NORMAL_PRIORITY_CLASS

    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=False,
        creationflags=creationflags,
    )


def run_ffprobe(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
    cmd = [get_ffprobe_path(), *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def _parse_frame_rate(value: str | None) -> float:
    if not value:
        return 0.0

    if "/" in value:
        num_str, den_str = value.split("/", 1)
        try:
            num = float(num_str)
            den = float(den_str)
        except ValueError:
            return 0.0

        if den == 0:
            return 0.0
        return num / den

    try:
        return float(value)
    except ValueError:
        return 0.0


def probe_video(path: str) -> dict[str, Any]:
    result = run_ffprobe(
        [
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ]
    )

    if result.returncode != 0:
        message = (result.stderr or result.stdout or "").strip()
        if not message:
            message = f"ffprobe exited with code {result.returncode}"
        raise RuntimeError(message)

    payload = (result.stdout or "").strip()
    if not payload:
        raise RuntimeError("ffprobe returned no output")

    data = json.loads(payload)
    streams = data.get("streams") or []

    video_stream = None
    for stream in streams:
        if stream.get("codec_type") == "video":
            video_stream = stream
            break

    if not video_stream:
        raise RuntimeError("No video stream found")

    width = int(video_stream.get("width") or 0)
    height = int(video_stream.get("height") or 0)
    codec = str(video_stream.get("codec_name") or "")

    fps_value = video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate")
    fps = _parse_frame_rate(str(fps_value) if fps_value is not None else None)

    duration_sec: float | None = None
    stream_duration = video_stream.get("duration")
    if stream_duration is not None:
        try:
            duration_sec = float(stream_duration)
        except (TypeError, ValueError):
            duration_sec = None

    if duration_sec is None:
        fmt = data.get("format") or {}
        fmt_duration = fmt.get("duration")
        try:
            duration_sec = float(fmt_duration) if fmt_duration is not None else 0.0
        except (TypeError, ValueError):
            duration_sec = 0.0

    duration_ms = int(round((duration_sec or 0.0) * 1000.0))

    return {
        "duration_ms": duration_ms,
        "width": width,
        "height": height,
        "fps": fps,
        "codec": codec,
    }


def extract_frame(
    path: str,
    timestamp_ms: int,
    output_path: str,
    use_hw: bool = True,
) -> str:
    """Extract a single frame, using GPU decode if available."""
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    timestamp_sec = max(0, int(timestamp_ms)) / 1000.0

    # Build args with optional HW acceleration
    args: list[str] = ["-y"]

    # Add hardware decode if available
    if use_hw:
        hw_args = get_hw_decode_args()
        args.extend(hw_args)

    # Seek before input for speed
    args.extend(["-ss", f"{timestamp_sec:.3f}"])
    args.extend(["-i", path])
    args.extend(["-frames:v", "1", "-q:v", "2"])
    args.append(str(output))

    result = run_ffmpeg(args, priority="low")

    # Fallback to CPU if HW failed
    if result.returncode != 0 and use_hw:
        return extract_frame(path, timestamp_ms, output_path, use_hw=False)

    if result.returncode != 0:
        message = (result.stderr or result.stdout or "").strip()
        if not message:
            message = f"ffmpeg exited with code {result.returncode}"
        raise RuntimeError(message)

    if not output.exists():
        raise RuntimeError("FFmpeg did not produce output frame")

    return str(output)


def extract_frame_scaled(
    path: str,
    timestamp_ms: int,
    output_path: str,
    width: int,
    use_hw: bool = True,
) -> str:
    """Extract and scale a frame, using GPU if available."""
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    timestamp_sec = max(0, int(timestamp_ms)) / 1000.0
    safe_width = int(width)
    if safe_width <= 0:
        safe_width = 80

    caps = detect_gpu_capabilities()

    # Build optimized args
    args: list[str] = ["-y"]

    # HW decode
    if use_hw:
        hw_args = get_hw_decode_args()
        args.extend(hw_args)

    # Seek before input
    args.extend(["-ss", f"{timestamp_sec:.3f}"])
    args.extend(["-i", path])

    # Use GPU scaling if CUDA available, else CPU
    if use_hw and caps.has_cuda:
        # scale_cuda for GPU-accelerated scaling
        args.extend(["-vf", f"scale_cuda={safe_width}:-2,hwdownload,format=nv12"])
    else:
        args.extend(["-vf", f"scale={safe_width}:-2"])

    args.extend(["-frames:v", "1", "-q:v", "4"])
    args.append(str(output))

    result = run_ffmpeg(args, priority="low")

    # Fallback to CPU if HW failed
    if result.returncode != 0 and use_hw:
        return extract_frame_scaled(path, timestamp_ms, output_path, width, use_hw=False)

    if result.returncode == 0 and output.exists():
        return str(output)

    # Try alternate seek position (after input)
    args_alt: list[str] = [
        "-y",
        "-i", path,
        "-ss", f"{timestamp_sec:.3f}",
        "-vf", f"scale={safe_width}:-2",
        "-frames:v", "1",
        "-q:v", "4",
        str(output),
    ]
    result = run_ffmpeg(args_alt, priority="low")

    if result.returncode == 0 and output.exists():
        return str(output)

    message = (result.stderr or result.stdout or "").strip()
    if not message:
        message = f"ffmpeg exited with code {result.returncode}"

    raise RuntimeError(message)


def extract_filmstrip_batch(
    path: str,
    timestamps_ms: list[int],
    output_dir: str,
    width: int = 80,
) -> list[str]:
    """
    Extract multiple frames in a SINGLE FFmpeg call using the select filter.
    This is dramatically faster than calling extract_frame for each timestamp.
    Returns list of output file paths.
    """
    from pathlib import Path as P

    out_dir = P(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not timestamps_ms:
        return []

    safe_width = max(40, min(200, int(width)))

    # Get video duration to validate timestamps
    probe_result = run_ffprobe([
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "format=duration",
        "-of", "json",
        path,
    ])
    
    duration_ms = 0
    try:
        data = json.loads(probe_result.stdout)
        duration_ms = int(float(data.get("format", {}).get("duration", 0)) * 1000)
    except Exception:
        duration_ms = max(timestamps_ms) + 1000

    # Clamp timestamps
    valid_ts = [max(0, min(t, duration_ms - 100)) for t in timestamps_ms]

    # Build select expression: select frames near each timestamp
    # Using eq(n,X) where X is approximate frame number at 1fps scan rate
    # Better approach: use -ss for each output with multiple outputs
    
    # For small number of frames, use segment muxer approach
    # This extracts frames at specific times in one pass
    
    output_paths: list[str] = []
    
    # Use a single-pass approach with multiple -ss/-frames:v pairs
    # FFmpeg can handle multiple outputs efficiently
    args: list[str] = ["-y", "-i", path]
    
    for idx, ts in enumerate(valid_ts):
        ts_sec = ts / 1000.0
        out_path = out_dir / f"{idx}.jpg"
        output_paths.append(str(out_path))
        
        # Each output: seek to timestamp, scale, extract 1 frame
        args.extend([
            "-ss", f"{ts_sec:.3f}",
            "-vf", f"scale={safe_width}:-2",
            "-frames:v", "1",
            "-q:v", "5",  # Lower quality = faster + smaller
            str(out_path),
        ])

    # Run with low priority
    result = run_ffmpeg(args, priority="low")
    
    # If batch failed, return empty (caller will handle fallback)
    if result.returncode != 0:
        # Try simpler sequential approach as fallback
        return _extract_filmstrip_sequential(path, valid_ts, output_dir, safe_width)
    
    # Return only paths that exist
    return [p for p in output_paths if P(p).exists()]


def _extract_filmstrip_sequential(
    path: str,
    timestamps_ms: list[int],
    output_dir: str,
    width: int,
) -> list[str]:
    """Fallback: extract frames one by one (slower but more compatible)."""
    from pathlib import Path as P
    
    out_dir = P(output_dir)
    output_paths: list[str] = []
    
    for idx, ts in enumerate(timestamps_ms):
        out_path = out_dir / f"{idx}.jpg"
        ts_sec = ts / 1000.0
        
        args = [
            "-y",
            "-ss", f"{ts_sec:.3f}",
            "-i", path,
            "-vf", f"scale={width}:-2",
            "-frames:v", "1",
            "-q:v", "5",
            str(out_path),
        ]
        
        result = run_ffmpeg(args, priority="low")
        if result.returncode == 0 and out_path.exists():
            output_paths.append(str(out_path))
    
    return output_paths


def run_ffmpeg_async(
    args: Sequence[str],
    priority: Literal["low", "normal", "high"] = "normal",
) -> subprocess.Popen[str]:
    """
    Start FFmpeg as an async process (non-blocking).
    Returns Popen handle for progress monitoring.
    """
    cmd = [get_ffmpeg_path(), "-progress", "pipe:1", "-nostats", *args]

    creationflags = 0
    if os.name == "nt":
        if priority == "low":
            creationflags = subprocess.BELOW_NORMAL_PRIORITY_CLASS
        elif priority == "high":
            creationflags = subprocess.ABOVE_NORMAL_PRIORITY_CLASS

    return subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=creationflags,
    )


def transcode_video(
    input_path: str,
    output_path: str,
    codec: Literal["h264", "h265"] = "h264",
    quality: Literal["low", "medium", "high"] = "medium",
    resolution: tuple[int, int] | None = None,
    audio_bitrate: int = 320,
    use_hw: bool = True,
) -> subprocess.CompletedProcess[str]:
    """
    Transcode video with GPU acceleration if available.
    """
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    caps = detect_gpu_capabilities()

    args: list[str] = ["-y"]

    # Hardware decode
    if use_hw:
        hw_args = get_hw_decode_args()
        args.extend(hw_args)

    # Thread optimization
    args.extend(get_thread_args())

    # Input
    args.extend(["-i", input_path])

    # Video filter for resolution
    vf_parts: list[str] = []
    if resolution:
        w, h = resolution
        if use_hw and caps.has_cuda:
            vf_parts.append(f"scale_cuda={w}:{h}")
        else:
            vf_parts.append(f"scale={w}:{h}")

    if vf_parts:
        args.extend(["-vf", ",".join(vf_parts)])

    # Encoding
    args.extend(get_hw_encode_args(codec, quality, use_hw))

    # Audio
    args.extend(["-c:a", "aac", "-b:a", f"{audio_bitrate}k"])

    # Pixel format
    args.extend(["-pix_fmt", "yuv420p"])

    # Output
    args.append(str(output))

    result = run_ffmpeg(args, priority="normal")

    # Fallback to CPU if HW failed
    if result.returncode != 0 and use_hw:
        return transcode_video(
            input_path, output_path, codec, quality, resolution, audio_bitrate, use_hw=False
        )

    return result


def _sanitize_filter_label(value: str) -> str:
    out: list[str] = []
    for ch in value:
        if ch.isalnum() or ch == "_":
            out.append(ch)
        else:
            out.append("_")
    sanitized = "".join(out)
    if not sanitized:
        return "x"
    if sanitized[0].isdigit():
        return f"x_{sanitized}"
    return sanitized


def generate_effect_filters(layer: Layer) -> str:
    parts: list[str] = []

    fx = layer.effects
    if fx.black_and_white:
        parts.append(
            "colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3:0"
        )

    if fx.wave_enabled:
        amp = float(fx.wave_amplitude)
        freq = float(fx.wave_frequency)
        if freq == 0.0:
            freq = 0.001
        speed = float(fx.wave_speed)
        expr = f"lum(X+{amp}*sin(2*PI*Y/{freq}+T*{speed})\\,Y)"
        parts.append(f"geq=lum='{expr}'")

    if fx.zoom.enabled:
        end_scale = float(fx.zoom.end_scale)
        if end_scale <= 0.0:
            end_scale = 1.0
        parts.append(f"scale=iw*{end_scale}:ih*{end_scale}")
        parts.append(f"crop=iw/{end_scale}:ih/{end_scale}")

    return ",".join(parts)


def generate_clip_filter(
    clip: "ClipPlacement",
    layer: Layer,
    source: SourceVideo,
    cell: dict,
    output_resolution: tuple[int, int],
) -> str:
    out_w, out_h = output_resolution
    cell_w = int(cell.get("width") or 0)
    cell_h = int(cell.get("height") or 0)
    cell_x = int(cell.get("x") or 0)
    cell_y = int(cell.get("y") or 0)

    if cell_w <= 0:
        cell_w = out_w
    if cell_h <= 0:
        cell_h = out_h

    layer_id = _sanitize_filter_label(str(layer.id))
    clip_idx = int(getattr(clip, "clip_index", 0))

    clip_label = f"clip_{layer_id}_{clip_idx}"
    base_label = f"base_{layer_id}_{clip_idx}"
    out_label = f"clipout_{layer_id}_{clip_idx}"

    flip_state = str(getattr(clip, "flip_state", "normal"))
    flip_filters: list[str] = []
    if flip_state in {"h_flip", "hv_flip"}:
        flip_filters.append("hflip")
    if flip_state in {"v_flip", "hv_flip"}:
        flip_filters.append("vflip")

    velocity = int(getattr(clip, "velocity", 127))
    if velocity < 0:
        velocity = 0
    if velocity > 127:
        velocity = 127
    alpha = velocity / 127.0

    opacity_filters: list[str] = ["format=rgba"]
    if bool(getattr(layer, "velocity_opacity", True)):
        opacity_filters.append(f"colorchannelmixer=aa={alpha:.6f}")

    dur_ms = int(getattr(clip, "duration_ms", 0))
    if dur_ms <= 0:
        dur_ms = 1
    dur_sec = max(0.001, dur_ms / 1000.0)

    src_start_ms = int(getattr(clip, "source_start_ms", 0))
    if src_start_ms < 0:
        src_start_ms = 0

    chain_parts: list[str] = [
        f"[0:v]trim=start={src_start_ms}ms:duration={dur_ms}ms",
        "setpts=PTS-STARTPTS",
        f"scale={cell_w}:{cell_h}:force_original_aspect_ratio=decrease",
        f"pad={cell_w}:{cell_h}:(ow-iw)/2:(oh-ih)/2",
        *flip_filters,
        *opacity_filters,
    ]

    chain = (
        f"{','.join(chain_parts)}[{clip_label}];"
        f"color=c=black@0.0:s={out_w}x{out_h}:d={dur_sec:.6f},format=rgba[{base_label}];"
        f"[{base_label}][{clip_label}]overlay={cell_x}:{cell_y}:format=auto[{out_label}]"
    )

    _ = source
    return chain


def generate_layer_filter_chain(
    layer: Layer,
    clips: list["ClipPlacement"],
    source: SourceVideo,
    cell: dict,
    output_resolution: tuple[int, int],
) -> str:
    if not clips:
        return ""

    layer_id = _sanitize_filter_label(str(layer.id))

    out_w, out_h = output_resolution

    clip_filters: list[str] = []
    out_labels: list[str] = []

    sorted_clips = sorted(clips, key=lambda c: int(getattr(c, "start_ms", 0)))
    cursor_ms = 0

    for seg_index, clip in enumerate(sorted_clips):
        start_ms = int(getattr(clip, "start_ms", 0))
        if start_ms < 0:
            start_ms = 0

        gap_ms = start_ms - cursor_ms
        if gap_ms > 0:
            gap_sec = gap_ms / 1000.0
            gap_label = f"gap_{layer_id}_{seg_index}"
            clip_filters.append(
                f"color=c=black@0.0:s={out_w}x{out_h}:d={gap_sec:.6f},format=rgba[{gap_label}]"
            )
            out_labels.append(f"[{gap_label}]")
            cursor_ms += gap_ms

        clip_idx = int(getattr(clip, "clip_index", 0))
        out_label = f"clipout_{layer_id}_{clip_idx}"
        clip_filters.append(generate_clip_filter(clip, layer, source, cell, output_resolution))
        out_labels.append(f"[{out_label}]")

        dur_ms = int(getattr(clip, "duration_ms", 0))
        if dur_ms < 0:
            dur_ms = 0
        cursor_ms = max(cursor_ms, start_ms + dur_ms)

    effects = generate_effect_filters(layer)
    if effects:
        tail = f"concat=n={len(out_labels)}:v=1:a=0[vcat];[vcat]{effects}[v]"
    else:
        tail = f"concat=n={len(out_labels)}:v=1:a=0[v]"

    return ";".join([*clip_filters, f"{''.join(out_labels)}{tail}"])
