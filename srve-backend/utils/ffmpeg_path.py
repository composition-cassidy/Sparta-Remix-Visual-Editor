from __future__ import annotations

import os
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path


def _is_packaged() -> bool:
    return bool(getattr(sys, "frozen", False)) or hasattr(sys, "_MEIPASS")


def _app_directory() -> Path:
    try:
        return Path(__file__).resolve().parent.parent
    except Exception:
        return Path.cwd()


def _platform_exe_name(base: str) -> str:
    if os.name == "nt":
        return f"{base}.exe"
    return base


@lru_cache(maxsize=1)
def get_ffmpeg_path() -> str:
    override = os.environ.get("SRVE_FFMPEG_PATH")
    if override:
        candidate = Path(override)
        if candidate.exists():
            return str(candidate)

    base_dir = _app_directory()

    candidate = base_dir / "bin" / _platform_exe_name("ffmpeg")
    if candidate.exists():
        return str(candidate)

    candidate = base_dir / "resources" / "bin" / _platform_exe_name("ffmpeg")
    if candidate.exists():
        return str(candidate)

    if not _is_packaged():
        on_path = shutil.which("ffmpeg")
        if on_path:
            return on_path

    raise FileNotFoundError("FFmpeg binary not found. Set SRVE_FFMPEG_PATH or bundle ffmpeg.")


@lru_cache(maxsize=1)
def get_ffprobe_path() -> str:
    override = os.environ.get("SRVE_FFPROBE_PATH")
    if override:
        candidate = Path(override)
        if candidate.exists():
            return str(candidate)

    base_dir = _app_directory()

    candidate = base_dir / "bin" / _platform_exe_name("ffprobe")
    if candidate.exists():
        return str(candidate)

    candidate = base_dir / "resources" / "bin" / _platform_exe_name("ffprobe")
    if candidate.exists():
        return str(candidate)

    if not _is_packaged():
        on_path = shutil.which("ffprobe")
        if on_path:
            return on_path

    raise FileNotFoundError("FFprobe binary not found. Set SRVE_FFPROBE_PATH or bundle ffprobe.")


def verify_ffmpeg() -> tuple[bool, str]:
    try:
        result = subprocess.run(
            [get_ffmpeg_path(), "-version"],
            capture_output=True,
            text=True,
            check=False,
        )
    except Exception as exc:
        return False, str(exc)

    output = (result.stdout or "").strip()
    error_output = (result.stderr or "").strip()

    if result.returncode != 0:
        if error_output:
            return False, error_output
        if output:
            return False, output
        return False, f"ffmpeg exited with code {result.returncode}"

    version_line = output.splitlines()[0] if output else "ffmpeg available"
    return True, version_line
