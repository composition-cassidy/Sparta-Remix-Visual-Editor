from __future__ import annotations

import array
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel

from core.midi_parser import MidiData, parse_midi
from core.project import Project, SourceVideo
from utils.ffmpeg_path import get_ffmpeg_path
from utils.ffmpeg_utils import extract_frame, extract_frame_scaled, probe_video, run_ffprobe
from utils.filmstrip_cache import (
    are_thumbnails_disabled,
    clear_cache,
    disable_thumbnails,
    enable_thumbnails,
    generate_filmstrip_async,
    get_cache_status,
    get_cached_frames,
    get_filmstrip_cache,
    get_lod_for_zoom,
    is_generation_paused,
    pause_generation,
    resume_generation,
)

router = APIRouter(prefix="/media", tags=["media"])


class VideoThumbnailRequest(BaseModel):
    path: str
    timestamp_ms: int = 0


class VideoThumbnailResponse(BaseModel):
    image_base64: str


class VideoFilmstripRequest(BaseModel):
    video_path: str
    num_frames: int = 20


class VideoFrameRequest(BaseModel):
    video_path: str
    timestamp_ms: int
    max_width: int = 640


class VideoFilmstripSegmentRequest(BaseModel):
    video_path: str
    start_ms: int
    end_ms: int
    num_frames: int = 10


class VideoWaveformRequest(BaseModel):
    video_path: str
    samples_per_second: int = 100


class AudioAnalyzeRequest(BaseModel):
    path: str


class AudioAnalyzeResponse(BaseModel):
    path: str
    duration_ms: int
    sample_rate: int
    channels: int


@router.post("/video/analyze", response_model=SourceVideo)
async def analyze_video(
    request: Request,
    file: UploadFile | None = File(None),
    path: str | None = Form(None),
) -> SourceVideo:
    video_path: str | None = None

    if path:
        candidate = Path(path)
        if not candidate.exists():
            raise HTTPException(status_code=404, detail="Video file not found")
        video_path = str(candidate)

    if video_path is None and file is not None:
        temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
        uploads_dir = temp_dir / "uploads"
        uploads_dir.mkdir(parents=True, exist_ok=True)

        original_name = Path(file.filename or "upload").name
        dest = uploads_dir / f"{uuid.uuid4().hex}_{original_name}"

        try:
            with dest.open("wb") as f:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
        finally:
            await file.close()

        video_path = str(dest)

    if video_path is None:
        raise HTTPException(status_code=400, detail="Provide 'path' or upload a 'file'")

    try:
        meta = probe_video(video_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    duration_ms = int(meta.get("duration_ms") or 0)
    
    # Start filmstrip pre-generation in background (like Premiere's media cache)
    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    generate_filmstrip_async(video_path, duration_ms, temp_dir)
    
    return SourceVideo(
        id=str(uuid.uuid4()),
        name=Path(video_path).name,
        path=video_path,
        duration_ms=duration_ms,
        width=int(meta.get("width") or 0),
        height=int(meta.get("height") or 0),
        fps=float(meta.get("fps") or 0.0),
        codec=str(meta.get("codec") or ""),
    )


@router.post("/midi/import", response_model=MidiData)
def import_midi(request: Request, path: str = Form(...)) -> MidiData:
    midi_path = Path(path)
    if not midi_path.exists():
        raise HTTPException(status_code=404, detail="MIDI file not found")

    try:
        midi_data = parse_midi(str(midi_path))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    current_project = getattr(request.app.state, "current_project", None)
    if current_project is None:
        current_project = Project(name="Untitled Project")
        request.app.state.current_project = current_project

    current_project.midi_file_path = str(midi_path)
    current_project.bpm = float(midi_data.bpm)

    return midi_data


@router.post("/video/thumbnail", response_model=VideoThumbnailResponse)
def thumbnail_video(payload: VideoThumbnailRequest, request: Request) -> VideoThumbnailResponse:
    video_path = Path(payload.path)
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    timestamp_ms = int(payload.timestamp_ms or 0)
    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    thumbs_dir = temp_dir / "thumbnails"
    thumbs_dir.mkdir(parents=True, exist_ok=True)

    cache_key = f"{video_path}|{timestamp_ms}".encode("utf-8")
    digest = hashlib.sha1(cache_key).hexdigest()
    output_path = thumbs_dir / f"{digest}.jpg"

    if not output_path.exists():
        try:
            extract_frame(str(video_path), timestamp_ms, str(output_path))
        except FileNotFoundError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        raw = output_path.read_bytes()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return VideoThumbnailResponse(image_base64=base64.b64encode(raw).decode("ascii"))


@router.post("/video/filmstrip", response_model=list[str])
def filmstrip_video(payload: VideoFilmstripRequest, request: Request) -> list[str]:
    video_path = Path(payload.video_path)
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    num_frames = int(payload.num_frames or 20)
    if num_frames <= 0:
        raise HTTPException(status_code=400, detail="num_frames must be > 0")
    if num_frames > 200:
        raise HTTPException(status_code=400, detail="num_frames too large")

    try:
        stat = video_path.stat()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    strips_dir = temp_dir / "filmstrips"
    strips_dir.mkdir(parents=True, exist_ok=True)

    cache_key = f"{video_path}|{num_frames}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8")
    digest = hashlib.sha1(cache_key).hexdigest()
    cache_path = strips_dir / f"{digest}.json"

    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text("utf-8"))
            if isinstance(cached, list) and len(cached) == num_frames:
                return [str(x) for x in cached]
        except Exception:
            pass

    try:
        meta = probe_video(str(video_path))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    duration_ms = int(meta.get("duration_ms") or 0)
    safe_duration = max(0, duration_ms)

    frames_dir = strips_dir / digest
    frames_dir.mkdir(parents=True, exist_ok=True)

    timestamps: list[int] = []
    if num_frames == 1:
        timestamps = [0]
    else:
        last_ms = max(0, safe_duration - 1)
        for i in range(num_frames):
            if last_ms == 0:
                timestamps.append(0)
                continue
            t = int(round(last_ms * (i / float(num_frames - 1))))
            if t < 0:
                t = 0
            if t > last_ms:
                t = last_ms
            timestamps.append(t)

    frames: list[str] = []
    last_good_raw: bytes | None = None

    for idx, timestamp_ms in enumerate(timestamps):
        output_path = frames_dir / f"{idx}.jpg"

        raw: bytes | None = None
        last_error: str | None = None

        if output_path.exists():
            try:
                raw = output_path.read_bytes()
            except Exception as exc:
                raise HTTPException(status_code=500, detail=str(exc)) from exc
        else:
            retry_offsets = [0, 50, 100, 200, 500, 1000]
            for offset in retry_offsets:
                candidate_ms = max(0, int(timestamp_ms) - offset)
                try:
                    extract_frame_scaled(str(video_path), candidate_ms, str(output_path), 80)
                except FileNotFoundError as exc:
                    raise HTTPException(status_code=500, detail=str(exc)) from exc
                except RuntimeError as exc:
                    last_error = str(exc)
                    continue

                try:
                    raw = output_path.read_bytes()
                except Exception as exc:
                    raise HTTPException(status_code=500, detail=str(exc)) from exc
                break

        if raw is None or len(raw) == 0:
            if last_good_raw is not None:
                try:
                    output_path.write_bytes(last_good_raw)
                except Exception:
                    pass
                frames.append(base64.b64encode(last_good_raw).decode("ascii"))
                continue

            if last_error:
                raise HTTPException(status_code=400, detail=last_error)
            raise HTTPException(status_code=400, detail="FFmpeg did not produce output frame")

        last_good_raw = raw
        frames.append(base64.b64encode(raw).decode("ascii"))

    try:
        cache_path.write_text(json.dumps(frames), encoding="utf-8")
    except Exception:
        pass

    return frames


def _probe_audio(path: str) -> dict[str, int]:
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

    audio_stream = None
    for stream in streams:
        if stream.get("codec_type") == "audio":
            audio_stream = stream
            break

    if not audio_stream:
        raise RuntimeError("No audio stream found")

    sample_rate = int(audio_stream.get("sample_rate") or 0)
    channels = int(audio_stream.get("channels") or 0)

    duration_sec: float | None = None
    stream_duration = audio_stream.get("duration")
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
        "sample_rate": sample_rate,
        "channels": channels,
    }


@router.post("/video/frame")
def video_frame(payload: VideoFrameRequest, request: Request) -> dict:
    """Extract a single frame at exact timestamp for trimmer preview."""
    video_path = Path(payload.video_path)
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    timestamp_ms = max(0, int(payload.timestamp_ms))
    max_width = int(payload.max_width)
    if max_width <= 0:
        max_width = 640
    if max_width > 1920:
        max_width = 1920

    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    frames_dir = temp_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    cache_key = f"{video_path}|{timestamp_ms}|{max_width}".encode("utf-8")
    digest = hashlib.sha1(cache_key).hexdigest()
    output_path = frames_dir / f"{digest}.jpg"

    if not output_path.exists():
        try:
            extract_frame_scaled(str(video_path), timestamp_ms, str(output_path), max_width)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        raw = output_path.read_bytes()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "timestamp_ms": timestamp_ms,
        "image_base64": base64.b64encode(raw).decode("ascii"),
    }


@router.post("/video/filmstrip-segment")
def filmstrip_segment(payload: VideoFilmstripSegmentRequest, request: Request) -> list[dict]:
    """
    Get thumbnails for a time range from PRE-GENERATED cache.
    Like Premiere Pro - thumbnails are generated at import, not on-demand.
    Falls back to on-demand only if cache isn't ready yet.
    """
    video_path = Path(payload.video_path)
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    start_ms = max(0, int(payload.start_ms))
    end_ms = max(start_ms, int(payload.end_ms))
    num_frames = int(payload.num_frames)
    if num_frames <= 0:
        num_frames = 10
    if num_frames > 100:
        num_frames = 100

    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    
    # Calculate zoom level from request params
    visible_duration = end_ms - start_ms
    # Assume ~800px timeline width, estimate zoom
    zoom = 1.0
    if visible_duration > 0:
        # Higher num_frames for same duration = more zoomed in
        zoom = max(1.0, num_frames / 8.0)
    
    # TRY PRE-GENERATED CACHE FIRST (instant, no FFmpeg)
    cache = get_filmstrip_cache(str(video_path), temp_dir)
    if cache and cache.ready:
        cached_frames = get_cached_frames(cache, start_ms, end_ms, zoom)
        if cached_frames:
            # Subsample to requested num_frames
            step = max(1, len(cached_frames) // num_frames)
            selected = cached_frames[::step][:num_frames]
            return [
                {
                    "timestamp_ms": ts,
                    "image_base64": base64.b64encode(data).decode("ascii"),
                }
                for ts, data in selected
            ]
    
    # FALLBACK: On-demand generation (only if cache not ready)
    segments_dir = temp_dir / "filmstrip_segments"
    segments_dir.mkdir(parents=True, exist_ok=True)

    cache_key = f"{video_path}|{start_ms}|{end_ms}|{num_frames}".encode("utf-8")
    digest = hashlib.sha1(cache_key).hexdigest()
    cache_path = segments_dir / f"{digest}.json"

    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text("utf-8"))
            if isinstance(cached, list):
                return cached
        except Exception:
            pass

    segment_dir = segments_dir / digest
    segment_dir.mkdir(parents=True, exist_ok=True)

    timestamps: list[int] = []
    if num_frames == 1:
        timestamps = [start_ms]
    else:
        for i in range(num_frames):
            t = start_ms + int(round((end_ms - start_ms) * (i / float(num_frames - 1))))
            timestamps.append(t)

    # Check if all frames already exist (cached)
    all_cached = all((segment_dir / f"{i}.jpg").exists() for i in range(len(timestamps)))
    
    if not all_cached:
        # Use batch extraction - SINGLE FFmpeg call for all frames
        from utils.ffmpeg_utils import extract_filmstrip_batch
        extract_filmstrip_batch(
            str(video_path),
            timestamps,
            str(segment_dir),
            width=80,
        )

    # Read results
    results: list[dict] = []
    last_good_raw: bytes | None = None

    for idx, ts in enumerate(timestamps):
        output_path = segment_dir / f"{idx}.jpg"
        raw: bytes | None = None

        if output_path.exists():
            try:
                raw = output_path.read_bytes()
            except Exception:
                pass

        if raw is None or len(raw) == 0:
            if last_good_raw is not None:
                raw = last_good_raw
            else:
                continue

        last_good_raw = raw
        results.append({
            "timestamp_ms": ts,
            "image_base64": base64.b64encode(raw).decode("ascii"),
        })

    try:
        cache_path.write_text(json.dumps(results), encoding="utf-8")
    except Exception:
        pass

    return results


class FilmstripCacheStatusRequest(BaseModel):
    video_path: str
    duration_ms: int = 0


@router.post("/video/filmstrip-cache-status")
def filmstrip_cache_status(payload: FilmstripCacheStatusRequest, request: Request) -> dict:
    """
    Check filmstrip cache status and trigger generation if not started.
    Returns: {ready: bool, generating: bool, progress: float}
    """
    video_path = Path(payload.video_path)
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")
    
    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    
    # Check for existing cache
    cache = get_filmstrip_cache(str(video_path), temp_dir)
    
    if cache:
        return {
            "ready": cache.ready,
            "generating": cache.generating,
            "progress": cache.progress,
            "lod_info": cache.lod_info if cache.ready else {},
        }
    
    # Start generation if duration provided
    if payload.duration_ms > 0:
        cache = generate_filmstrip_async(str(video_path), payload.duration_ms, temp_dir)
        return {
            "ready": cache.ready,
            "generating": cache.generating,
            "progress": cache.progress,
            "lod_info": {},
        }
    
    return {
        "ready": False,
        "generating": False,
        "progress": 0.0,
        "lod_info": {},
    }


# ============ Cache Control Endpoints ============

class CacheClearRequest(BaseModel):
    video_path: str | None = None  # If None, clear all caches


@router.post("/cache/status")
def cache_status_endpoint() -> dict:
    """Get overall thumbnail cache status."""
    return get_cache_status()


@router.post("/cache/pause")
def cache_pause_endpoint() -> dict:
    """Pause all ongoing thumbnail generation."""
    pause_generation()
    return {"paused": True, "message": "Thumbnail generation paused"}


@router.post("/cache/resume")
def cache_resume_endpoint() -> dict:
    """Resume paused thumbnail generation."""
    resume_generation()
    return {"paused": False, "message": "Thumbnail generation resumed"}


@router.post("/cache/clear")
def cache_clear_endpoint(payload: CacheClearRequest, request: Request) -> dict:
    """Clear thumbnail cache (all or specific video)."""
    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    cleared = clear_cache(temp_dir, payload.video_path)
    return {
        "cleared": cleared,
        "message": f"Cleared {cleared} cache entries",
        "video_path": payload.video_path,
    }


@router.post("/cache/disable-thumbnails")
def cache_disable_thumbnails_endpoint(request: Request) -> dict:
    """
    Disable thumbnails completely.
    Stops all generation, clears cache, and returns empty thumbnails.
    User will rely on video playback for clip selection.
    """
    disable_thumbnails()
    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    cleared = clear_cache(temp_dir)
    return {
        "thumbnails_disabled": True,
        "cleared": cleared,
        "message": "Thumbnails disabled. Use video playback for clip selection.",
    }


@router.post("/cache/enable-thumbnails")
def cache_enable_thumbnails_endpoint() -> dict:
    """Re-enable thumbnails."""
    enable_thumbnails()
    return {
        "thumbnails_disabled": False,
        "message": "Thumbnails enabled. Import videos to generate cache.",
    }


@router.post("/video/waveform")
def video_waveform(payload: VideoWaveformRequest, request: Request) -> dict:
    """Extract audio waveform data from video for trimmer timeline."""
    video_path = Path(payload.video_path)
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    samples_per_second = int(payload.samples_per_second)
    if samples_per_second <= 0:
        samples_per_second = 100
    if samples_per_second > 1000:
        samples_per_second = 1000

    try:
        stat = video_path.stat()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    waves_dir = temp_dir / "video_waveforms"
    waves_dir.mkdir(parents=True, exist_ok=True)

    cache_key = f"{video_path}|{samples_per_second}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8")
    digest = hashlib.sha1(cache_key).hexdigest()
    cache_path = waves_dir / f"{digest}.json"

    if cache_path.exists():
        try:
            return json.loads(cache_path.read_text("utf-8"))
        except Exception:
            pass

    try:
        meta = probe_video(str(video_path))
    except (FileNotFoundError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    duration_ms = int(meta.get("duration_ms") or 0)
    duration_sec = duration_ms / 1000.0
    total_samples = int(duration_sec * samples_per_second)
    if total_samples <= 0:
        total_samples = 1
    if total_samples > 50000:
        total_samples = 50000

    try:
        values = _compute_waveform(str(video_path), total_samples)
    except (FileNotFoundError, RuntimeError):
        values = [0.0] * total_samples

    result = {
        "duration_ms": duration_ms,
        "samples_per_second": samples_per_second,
        "amplitudes": values,
    }

    try:
        cache_path.write_text(json.dumps(result), encoding="utf-8")
    except Exception:
        pass

    return result


@router.post("/audio/analyze", response_model=AudioAnalyzeResponse)
def analyze_audio(path: str = Form(...)) -> AudioAnalyzeResponse:
    audio_path = Path(path)
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    try:
        meta = _probe_audio(str(audio_path))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return AudioAnalyzeResponse(
        path=str(audio_path),
        duration_ms=int(meta.get("duration_ms") or 0),
        sample_rate=int(meta.get("sample_rate") or 0),
        channels=int(meta.get("channels") or 0),
    )


def _compute_waveform(path: str, width: int) -> list[float]:
    if width <= 0:
        return []

    result = subprocess.run(
        [
            get_ffmpeg_path(),
            "-v",
            "error",
            "-i",
            path,
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "s16le",
            "-",
        ],
        capture_output=True,
        check=False,
    )

    if result.returncode != 0:
        message = (result.stderr or result.stdout or b"").decode("utf-8", errors="replace").strip()
        if not message:
            message = f"ffmpeg exited with code {result.returncode}"
        raise RuntimeError(message)

    raw = result.stdout or b""
    if not raw:
        return [0.0 for _ in range(width)]

    samples = array.array("h")
    samples.frombytes(raw)
    if not samples:
        return [0.0 for _ in range(width)]

    total = len(samples)
    step = total / float(width)
    out: list[float] = []

    for i in range(width):
        start = int(i * step)
        end = int((i + 1) * step)
        if end <= start:
            end = start + 1
        if start >= total:
            out.append(0.0)
            continue
        if end > total:
            end = total

        max_val = 0
        for s in samples[start:end]:
            v = -s if s < 0 else s
            if v > max_val:
                max_val = v

        out.append(float(max_val) / 32768.0)

    return out


@router.get("/audio/waveform")
def audio_waveform(path: str, width: int, request: Request) -> list[float]:
    audio_path = Path(path)
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    safe_width = int(width)
    if safe_width <= 0:
        raise HTTPException(status_code=400, detail="Width must be > 0")
    if safe_width > 10000:
        raise HTTPException(status_code=400, detail="Width too large")

    try:
        stat = audio_path.stat()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    temp_dir = Path(getattr(request.app.state, "temp_dir", Path.cwd() / "temp"))
    waves_dir = temp_dir / "waveforms"
    waves_dir.mkdir(parents=True, exist_ok=True)

    cache_key = f"{audio_path}|{safe_width}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8")
    digest = hashlib.sha1(cache_key).hexdigest()
    cache_path = waves_dir / f"{digest}.json"

    if cache_path.exists():
        try:
            return json.loads(cache_path.read_text("utf-8"))
        except Exception:
            pass

    try:
        values = _compute_waveform(str(audio_path), safe_width)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        cache_path.write_text(json.dumps(values), encoding="utf-8")
    except Exception:
        pass

    return values
