"""
Pre-generated filmstrip cache system.

Like Premiere Pro's media cache - generates ALL thumbnails at import time,
not on-demand during zoom. This eliminates lag when zooming.

Approach:
1. At video import: generate complete filmstrip at multiple LOD levels
2. Store as sprite sheets (many frames in one image) for fast I/O
3. Frontend requests tiles from pre-generated cache - zero FFmpeg calls
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from utils.ffmpeg_path import get_ffmpeg_path
from utils.ffmpeg_utils import run_ffmpeg


@dataclass
class FilmstripLOD:
    """Level of Detail for filmstrip."""
    name: str
    frames_per_minute: int  # How many frames per minute of video
    thumb_width: int        # Thumbnail width in pixels


# LOD levels - from coarse (zoomed out) to fine (zoomed in)
LOD_LEVELS = [
    FilmstripLOD("lod0", frames_per_minute=6, thumb_width=60),    # 1 frame per 10 sec
    FilmstripLOD("lod1", frames_per_minute=30, thumb_width=80),   # 1 frame per 2 sec  
    FilmstripLOD("lod2", frames_per_minute=120, thumb_width=100), # 2 frames per sec
    FilmstripLOD("lod3", frames_per_minute=300, thumb_width=120), # 5 frames per sec
]

# How many frames per sprite sheet row/column
SPRITE_COLS = 10
SPRITE_ROWS = 10
FRAMES_PER_SPRITE = SPRITE_COLS * SPRITE_ROWS  # 100 frames per sprite


@dataclass
class FilmstripCache:
    """Cached filmstrip data for a video."""
    video_path: str
    video_hash: str
    duration_ms: int
    cache_dir: Path
    lod_info: dict[str, dict]  # LOD name -> {num_frames, num_sprites, thumb_width}
    ready: bool = False
    generating: bool = False
    progress: float = 0.0


# Global cache registry
_cache_registry: dict[str, FilmstripCache] = {}
_cache_lock = threading.Lock()

# Global pause flag
_generation_paused = False
_thumbnails_disabled = False


def get_video_hash(video_path: str) -> str:
    """Generate a stable hash for a video file."""
    p = Path(video_path)
    if not p.exists():
        return hashlib.sha1(video_path.encode()).hexdigest()[:16]
    
    # Hash based on path + size + mtime for stability
    stat = p.stat()
    key = f"{video_path}|{stat.st_size}|{stat.st_mtime}"
    return hashlib.sha1(key.encode()).hexdigest()[:16]


def get_cache_dir(base_temp_dir: Path, video_hash: str) -> Path:
    """Get the cache directory for a video's filmstrip."""
    return base_temp_dir / "filmstrip_cache" / video_hash


def get_lod_for_zoom(zoom: float) -> FilmstripLOD:
    """Select appropriate LOD based on zoom level."""
    if zoom < 2:
        return LOD_LEVELS[0]
    elif zoom < 5:
        return LOD_LEVELS[1]
    elif zoom < 15:
        return LOD_LEVELS[2]
    else:
        return LOD_LEVELS[3]


def generate_filmstrip_lod(
    video_path: str,
    output_dir: Path,
    lod: FilmstripLOD,
    duration_ms: int,
    on_progress: Callable[[float], None] | None = None,
) -> dict:
    """
    Generate a complete filmstrip for one LOD level using FFmpeg's fps filter.
    This extracts frames at regular intervals in a SINGLE FFmpeg pass.
    """
    lod_dir = output_dir / lod.name
    lod_dir.mkdir(parents=True, exist_ok=True)
    
    # Calculate total frames needed
    duration_min = duration_ms / 60000.0
    total_frames = max(1, int(duration_min * lod.frames_per_minute))
    
    # FPS for extraction
    fps = lod.frames_per_minute / 60.0  # frames per second
    
    # Generate all frames in one FFmpeg call using fps filter
    # This is MUCH faster than seeking to each timestamp
    output_pattern = str(lod_dir / "frame_%05d.jpg")
    
    args = [
        "-y",
        "-i", video_path,
        "-vf", f"fps={fps:.6f},scale={lod.thumb_width}:-2",
        "-q:v", "5",
        "-vsync", "vfr",
        output_pattern,
    ]
    
    result = run_ffmpeg(args, priority="low")
    
    if result.returncode != 0:
        # Fallback: try with a simpler approach
        args_fallback = [
            "-y",
            "-i", video_path,
            "-vf", f"fps=1/{60/lod.frames_per_minute:.2f},scale={lod.thumb_width}:-2",
            "-q:v", "5",
            output_pattern,
        ]
        result = run_ffmpeg(args_fallback, priority="low")
    
    # Count generated frames
    generated = list(lod_dir.glob("frame_*.jpg"))
    
    if on_progress:
        on_progress(1.0)
    
    return {
        "name": lod.name,
        "num_frames": len(generated),
        "thumb_width": lod.thumb_width,
        "frames_per_minute": lod.frames_per_minute,
    }


def generate_filmstrip_async(
    video_path: str,
    duration_ms: int,
    base_temp_dir: Path,
    on_complete: Callable[[FilmstripCache], None] | None = None,
) -> FilmstripCache:
    """
    Start async generation of complete filmstrip cache for a video.
    Returns immediately with a cache object that tracks progress.
    """
    video_hash = get_video_hash(video_path)
    cache_dir = get_cache_dir(base_temp_dir, video_hash)
    
    with _cache_lock:
        if video_hash in _cache_registry:
            existing = _cache_registry[video_hash]
            if existing.ready or existing.generating:
                return existing
    
    cache = FilmstripCache(
        video_path=video_path,
        video_hash=video_hash,
        duration_ms=duration_ms,
        cache_dir=cache_dir,
        lod_info={},
        ready=False,
        generating=True,
        progress=0.0,
    )
    
    with _cache_lock:
        _cache_registry[video_hash] = cache
    
    def generate():
        global _generation_paused, _thumbnails_disabled
        try:
            # Check if thumbnails are disabled
            if _thumbnails_disabled:
                cache.generating = False
                cache.progress = 0.0
                return
            
            cache_dir.mkdir(parents=True, exist_ok=True)
            
            total_lods = len(LOD_LEVELS)
            for i, lod in enumerate(LOD_LEVELS):
                # Check pause/disable flags
                while _generation_paused and not _thumbnails_disabled:
                    import time
                    time.sleep(0.5)
                    cache.progress = (i) / total_lods  # Keep current progress
                
                if _thumbnails_disabled:
                    cache.generating = False
                    cache.progress = 0.0
                    return
                
                def update_progress(p: float):
                    cache.progress = (i + p) / total_lods
                
                info = generate_filmstrip_lod(
                    video_path,
                    cache_dir,
                    lod,
                    duration_ms,
                    on_progress=update_progress,
                )
                cache.lod_info[lod.name] = info
            
            # Save metadata
            meta = {
                "video_path": video_path,
                "video_hash": video_hash,
                "duration_ms": duration_ms,
                "lod_info": cache.lod_info,
            }
            (cache_dir / "meta.json").write_text(json.dumps(meta, indent=2))
            
            cache.ready = True
            cache.generating = False
            cache.progress = 1.0
            
            if on_complete:
                on_complete(cache)
                
        except Exception as e:
            cache.generating = False
            cache.progress = -1.0  # Error state
            print(f"Filmstrip generation error: {e}")
    
    thread = threading.Thread(target=generate, daemon=True)
    thread.start()
    
    return cache


def get_filmstrip_cache(video_path: str, base_temp_dir: Path) -> FilmstripCache | None:
    """Get existing filmstrip cache for a video, if available."""
    video_hash = get_video_hash(video_path)
    
    with _cache_lock:
        if video_hash in _cache_registry:
            return _cache_registry[video_hash]
    
    # Check if cache exists on disk
    cache_dir = get_cache_dir(base_temp_dir, video_hash)
    meta_path = cache_dir / "meta.json"
    
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
            cache = FilmstripCache(
                video_path=meta["video_path"],
                video_hash=video_hash,
                duration_ms=meta["duration_ms"],
                cache_dir=cache_dir,
                lod_info=meta["lod_info"],
                ready=True,
                generating=False,
                progress=1.0,
            )
            with _cache_lock:
                _cache_registry[video_hash] = cache
            return cache
        except Exception:
            pass
    
    return None


def get_cached_frames(
    cache: FilmstripCache,
    start_ms: int,
    end_ms: int,
    zoom: float,
) -> list[tuple[int, bytes]]:
    """
    Get frames from cache for a time range.
    Returns list of (timestamp_ms, jpeg_bytes) tuples.
    """
    if not cache.ready:
        return []
    
    lod = get_lod_for_zoom(zoom)
    lod_info = cache.lod_info.get(lod.name)
    if not lod_info:
        return []
    
    lod_dir = cache.cache_dir / lod.name
    if not lod_dir.exists():
        return []
    
    # Calculate frame indices for the time range
    ms_per_frame = 60000.0 / lod.frames_per_minute
    start_idx = max(0, int(start_ms / ms_per_frame))
    end_idx = min(lod_info["num_frames"], int(end_ms / ms_per_frame) + 1)
    
    # Check if thumbnails are disabled
    global _thumbnails_disabled
    if _thumbnails_disabled:
        return []
    
    results: list[tuple[int, bytes]] = []
    for idx in range(start_idx, end_idx):
        frame_path = lod_dir / f"frame_{idx+1:05d}.jpg"
        if frame_path.exists():
            try:
                data = frame_path.read_bytes()
                timestamp = int(idx * ms_per_frame)
                results.append((timestamp, data))
            except Exception:
                pass
    
    return results


# ============ Cache Control Functions ============

def pause_generation() -> None:
    """Pause all ongoing filmstrip generation."""
    global _generation_paused
    _generation_paused = True


def resume_generation() -> None:
    """Resume paused filmstrip generation."""
    global _generation_paused
    _generation_paused = False


def is_generation_paused() -> bool:
    """Check if generation is paused."""
    return _generation_paused


def disable_thumbnails() -> None:
    """Disable thumbnails completely - stops generation and returns empty results."""
    global _thumbnails_disabled, _generation_paused
    _thumbnails_disabled = True
    _generation_paused = False  # Unpause so threads can exit


def enable_thumbnails() -> None:
    """Re-enable thumbnails."""
    global _thumbnails_disabled
    _thumbnails_disabled = False


def are_thumbnails_disabled() -> bool:
    """Check if thumbnails are disabled."""
    return _thumbnails_disabled


def clear_cache(base_temp_dir: Path, video_path: str | None = None) -> int:
    """
    Clear filmstrip cache.
    If video_path is provided, clear only that video's cache.
    Otherwise, clear all caches.
    Returns number of cache entries cleared.
    """
    global _cache_registry
    import shutil
    
    cleared = 0
    cache_base = base_temp_dir / "filmstrip_cache"
    
    if video_path:
        # Clear specific video cache
        video_hash = get_video_hash(video_path)
        cache_dir = get_cache_dir(base_temp_dir, video_hash)
        
        with _cache_lock:
            if video_hash in _cache_registry:
                del _cache_registry[video_hash]
                cleared += 1
        
        if cache_dir.exists():
            try:
                shutil.rmtree(cache_dir)
            except Exception:
                pass
    else:
        # Clear all caches
        with _cache_lock:
            cleared = len(_cache_registry)
            _cache_registry.clear()
        
        if cache_base.exists():
            try:
                shutil.rmtree(cache_base)
                cache_base.mkdir(parents=True, exist_ok=True)
            except Exception:
                pass
    
    # Also clear the old filmstrip_segments folder
    segments_dir = base_temp_dir / "filmstrip_segments"
    if segments_dir.exists():
        try:
            shutil.rmtree(segments_dir)
            segments_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
    
    return cleared


def get_cache_status() -> dict:
    """Get overall cache status."""
    with _cache_lock:
        generating_count = sum(1 for c in _cache_registry.values() if c.generating)
        ready_count = sum(1 for c in _cache_registry.values() if c.ready)
        
        return {
            "paused": _generation_paused,
            "thumbnails_disabled": _thumbnails_disabled,
            "total_cached": len(_cache_registry),
            "generating": generating_count,
            "ready": ready_count,
        }
