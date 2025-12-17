from __future__ import annotations

import gzip
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class ProjectSettings(BaseModel):
    output_resolution: tuple[int, int] = (1920, 1080)
    output_codec: Literal["h264", "h265"] = "h264"
    output_audio_bitrate: int = Field(default=320, le=512)
    preview_quality: Literal["low", "medium"] = "low"
    global_grid: tuple[int, int] = (3, 3)
    snap_to_grid: bool = True
    snap_subdivisions: int = 1


class VideoClipSettings(BaseModel):
    in_point_ms: int = 0
    out_point_ms: int = -1
    loop_mode: Literal["crossfade", "freeze", "continue"] = "freeze"
    crossfade_percent: float = 10.0


class FlipMode(str, Enum):
    NONE = "NONE"
    ALTERNATING = "ALTERNATING"
    ROTATION_CW = "ROTATION_CW"
    ROTATION_CCW = "ROTATION_CCW"


class EasingType(str, Enum):
    LINEAR = "LINEAR"
    EASE_OUT = "EASE_OUT"
    EASE_IN = "EASE_IN"
    EASE_SMOOTH = "EASE_SMOOTH"
    ELASTIC = "ELASTIC"


class ZoomEffect(BaseModel):
    enabled: bool = False
    start_scale: float = 1.0
    end_scale: float = 1.2
    easing: EasingType = EasingType.LINEAR
    easing_intensity: float = Field(default=1.0, ge=0.1, le=3.0)


class LayerEffects(BaseModel):
    black_and_white: bool = False
    wave_enabled: bool = False
    wave_amplitude: float = 10.0
    wave_frequency: float = 2.0
    wave_speed: float = 1.0
    zoom: ZoomEffect = Field(default_factory=ZoomEffect)


class Layer(BaseModel):
    id: str
    name: str
    source_video_id: str | None = None
    midi_channel: int = Field(ge=1, le=16)
    clip_settings: VideoClipSettings = Field(default_factory=VideoClipSettings)
    grid_position: tuple[int, int]
    use_global_grid: bool = True
    custom_grid: tuple[int, int] | None = None
    flip_mode: FlipMode = FlipMode.NONE
    velocity_opacity: bool = True
    note_length_mode: Literal["midi", "4th", "8th", "16th", "32nd"] = "midi"
    effects: LayerEffects = Field(default_factory=LayerEffects)
    order: int
    enabled: bool = True


class SourceVideo(BaseModel):
    id: str
    name: str
    path: str
    duration_ms: int
    width: int
    height: int
    fps: float
    codec: str = ""


class Project(BaseModel):
    version: str = "1.0"
    name: str
    settings: ProjectSettings = Field(default_factory=ProjectSettings)
    source_videos: list[SourceVideo] = Field(default_factory=list)
    layers: list[Layer] = Field(default_factory=list)
    midi_file_path: str | None = None
    bgm_path: str | None = None
    bgm_offset_ms: int = 0
    chorus_video_path: str | None = None
    chorus_offset_ms: int = 0
    bpm: float | None = None

    def to_srf(self) -> bytes:
        if hasattr(self, "model_dump_json"):
            payload = self.model_dump_json()
        else:
            payload = self.json()

        return gzip.compress(payload.encode("utf-8"))

    @classmethod
    def from_srf(cls, data: bytes) -> Project:
        payload = gzip.decompress(data).decode("utf-8")

        if hasattr(cls, "model_validate_json"):
            return cls.model_validate_json(payload)
        return cls.parse_raw(payload)
