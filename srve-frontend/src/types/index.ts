export interface ProjectSettings {
  output_resolution: [number, number];
  output_codec: 'h264' | 'h265';
  output_audio_bitrate: number;
  preview_quality: 'low' | 'medium';
  global_grid: [number, number];
  snap_to_grid: boolean;
  snap_subdivisions: number;
}

export interface VideoClipSettings {
  in_point_ms: number;
  out_point_ms: number;
  loop_mode: 'crossfade' | 'freeze' | 'continue';
  crossfade_percent: number;
}

export enum FlipMode {
  NONE = 'NONE',
  ALTERNATING = 'ALTERNATING',
  ROTATION_CW = 'ROTATION_CW',
  ROTATION_CCW = 'ROTATION_CCW',
}

export enum EasingType {
  LINEAR = 'LINEAR',
  EASE_OUT = 'EASE_OUT',
  EASE_IN = 'EASE_IN',
  EASE_SMOOTH = 'EASE_SMOOTH',
  ELASTIC = 'ELASTIC',
}

export interface ZoomEffect {
  enabled: boolean;
  start_scale: number;
  end_scale: number;
  easing: EasingType;
  easing_intensity: number;
}

export interface LayerEffects {
  black_and_white: boolean;
  wave_enabled: boolean;
  wave_amplitude: number;
  wave_frequency: number;
  wave_speed: number;
  zoom: ZoomEffect;
}

export interface SourceVideo {
  id: string;
  name: string;
  path: string;
  duration_ms: number;
  width: number;
  height: number;
  fps: number;
  codec?: string;
}

export interface Layer {
  id: string;
  name: string;
  source_video_id: string | null;
  midi_channel: number;
  clip_settings: VideoClipSettings;
  grid_position: [number, number];
  use_global_grid: boolean;
  custom_grid: [number, number] | null;
  flip_mode: FlipMode;
  velocity_opacity: boolean;
  note_length_mode: 'midi' | '4th' | '8th' | '16th' | '32nd';
  effects: LayerEffects;
  order: number;
  enabled: boolean;
}

export interface Project {
  version: string;
  name: string;
  settings: ProjectSettings;
  source_videos: SourceVideo[];
  layers: Layer[];
  midi_file_path: string | null;
  bgm_path: string | null;
  bgm_offset_ms: number;
  chorus_video_path: string | null;
  chorus_offset_ms: number;
  bpm: number | null;
}

export interface MidiNote {
  start_ms: number;
  end_ms: number;
  note: number;
  velocity: number;
  duration_ms: number;
}

export interface MidiData {
  bpm: number;
  duration_ms: number;
  channels: Record<number, MidiNote[]>;
}
