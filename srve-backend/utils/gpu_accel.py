from __future__ import annotations

import subprocess
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from utils.ffmpeg_path import get_ffmpeg_path


@dataclass
class GPUCapabilities:
    """Detected GPU hardware acceleration capabilities."""

    has_nvidia: bool = False
    has_nvenc_h264: bool = False
    has_nvenc_hevc: bool = False
    has_nvdec: bool = False
    has_cuda: bool = False
    has_qsv: bool = False  # Intel QuickSync
    has_amf: bool = False  # AMD AMF

    @property
    def can_hw_decode(self) -> bool:
        return self.has_nvdec or self.has_cuda or self.has_qsv

    @property
    def can_hw_encode_h264(self) -> bool:
        return self.has_nvenc_h264 or self.has_qsv or self.has_amf

    @property
    def can_hw_encode_hevc(self) -> bool:
        return self.has_nvenc_hevc or self.has_qsv or self.has_amf


@lru_cache(maxsize=1)
def detect_gpu_capabilities() -> GPUCapabilities:
    """Detect available GPU hardware acceleration."""
    caps = GPUCapabilities()

    try:
        # Check available encoders
        result = subprocess.run(
            [get_ffmpeg_path(), "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
        encoders = result.stdout or ""

        caps.has_nvenc_h264 = "h264_nvenc" in encoders
        caps.has_nvenc_hevc = "hevc_nvenc" in encoders
        caps.has_qsv = "h264_qsv" in encoders
        caps.has_amf = "h264_amf" in encoders

        # Check available decoders
        result = subprocess.run(
            [get_ffmpeg_path(), "-hide_banner", "-decoders"],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
        decoders = result.stdout or ""

        caps.has_nvdec = "h264_cuvid" in decoders or "hevc_cuvid" in decoders

        # Check hwaccels
        result = subprocess.run(
            [get_ffmpeg_path(), "-hide_banner", "-hwaccels"],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
        hwaccels = result.stdout or ""

        caps.has_cuda = "cuda" in hwaccels
        caps.has_nvidia = caps.has_nvenc_h264 or caps.has_nvdec or caps.has_cuda

    except Exception:
        pass

    return caps


def get_hw_decode_args(input_codec: str = "") -> list[str]:
    """
    Get FFmpeg args to enable hardware decoding.
    Returns empty list if no HW decode available.
    """
    caps = detect_gpu_capabilities()

    if caps.has_cuda:
        # CUDA provides the best compatibility for NVIDIA
        return ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]

    if caps.has_nvdec:
        # Fallback to cuvid decoder
        if input_codec in ("h264", "avc"):
            return ["-c:v", "h264_cuvid"]
        if input_codec in ("hevc", "h265"):
            return ["-c:v", "hevc_cuvid"]

    if caps.has_qsv:
        return ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"]

    return []


def get_hw_encode_args(
    codec: Literal["h264", "h265"] = "h264",
    quality: Literal["low", "medium", "high"] = "medium",
    use_hw: bool = True,
) -> list[str]:
    """
    Get FFmpeg args for encoding (GPU if available, else CPU).

    quality levels:
      - low: fastest, lower quality (preview)
      - medium: balanced (default)
      - high: slower, best quality (final render)
    """
    caps = detect_gpu_capabilities()

    # Preset/CRF mapping
    presets = {
        "low": ("p1", "ultrafast", 28),
        "medium": ("p4", "medium", 23),
        "high": ("p7", "slow", 18),
    }
    nvenc_preset, cpu_preset, crf = presets.get(quality, presets["medium"])

    # Try NVIDIA NVENC
    if use_hw and codec == "h264" and caps.has_nvenc_h264:
        return [
            "-c:v", "h264_nvenc",
            "-preset", nvenc_preset,
            "-rc", "vbr",
            "-cq", str(crf),
            "-b:v", "0",
        ]

    if use_hw and codec == "h265" and caps.has_nvenc_hevc:
        return [
            "-c:v", "hevc_nvenc",
            "-preset", nvenc_preset,
            "-rc", "vbr",
            "-cq", str(crf),
            "-b:v", "0",
        ]

    # Try Intel QuickSync
    if use_hw and caps.has_qsv:
        encoder = "h264_qsv" if codec == "h264" else "hevc_qsv"
        return [
            "-c:v", encoder,
            "-preset", "medium",
            "-global_quality", str(crf + 5),
        ]

    # Try AMD AMF
    if use_hw and caps.has_amf:
        encoder = "h264_amf" if codec == "h264" else "hevc_amf"
        return [
            "-c:v", encoder,
            "-quality", "balanced",
            "-rc", "vbr_latency",
        ]

    # Fallback: CPU libx264/libx265
    if codec == "h264":
        return [
            "-c:v", "libx264",
            "-preset", cpu_preset,
            "-crf", str(crf),
        ]

    return [
        "-c:v", "libx265",
        "-preset", cpu_preset,
        "-crf", str(crf),
    ]


def get_thread_args(max_threads: int | None = None) -> list[str]:
    """
    Get optimal thread configuration for FFmpeg.
    """
    import os

    cpu_count = os.cpu_count() or 4

    # Use most cores but leave 1-2 for system
    if max_threads is None:
        max_threads = max(1, cpu_count - 2)

    return [
        "-threads", str(max_threads),
        "-filter_threads", str(max(1, max_threads // 2)),
    ]


def get_optimized_input_args(input_path: str, input_codec: str = "") -> list[str]:
    """
    Get optimized input arguments including HW decode if available.
    """
    args: list[str] = []

    # Add hardware decode args
    hw_decode = get_hw_decode_args(input_codec)
    args.extend(hw_decode)

    # Thread optimization
    args.extend(get_thread_args())

    # Input file
    args.extend(["-i", input_path])

    return args


def get_optimized_output_args(
    output_path: str,
    codec: Literal["h264", "h265"] = "h264",
    quality: Literal["low", "medium", "high"] = "medium",
    audio_bitrate: int = 320,
    use_hw: bool = True,
) -> list[str]:
    """
    Get optimized output arguments including HW encode if available.
    """
    args: list[str] = []

    # Video encoding
    args.extend(get_hw_encode_args(codec, quality, use_hw))

    # Audio encoding (AAC is universally compatible)
    args.extend(["-c:a", "aac", "-b:a", f"{audio_bitrate}k"])

    # Pixel format for compatibility
    args.extend(["-pix_fmt", "yuv420p"])

    # Output file
    args.extend(["-y", output_path])

    return args


def print_gpu_info() -> str:
    """Get a human-readable summary of GPU capabilities."""
    caps = detect_gpu_capabilities()

    lines = ["GPU Acceleration Status:"]
    lines.append(f"  NVIDIA detected: {caps.has_nvidia}")
    lines.append(f"  CUDA available: {caps.has_cuda}")
    lines.append(f"  NVDEC (HW decode): {caps.has_nvdec}")
    lines.append(f"  NVENC H.264: {caps.has_nvenc_h264}")
    lines.append(f"  NVENC H.265: {caps.has_nvenc_hevc}")
    lines.append(f"  Intel QuickSync: {caps.has_qsv}")
    lines.append(f"  AMD AMF: {caps.has_amf}")

    return "\n".join(lines)
