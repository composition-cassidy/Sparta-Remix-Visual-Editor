import axios from 'axios';

import type { MidiData, Project, SourceVideo } from '../types';

export const client = axios.create({
  baseURL: 'http://localhost:8765',
});

function getApiErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as unknown;
    if (data && typeof data === 'object' && 'detail' in data) {
      const detail = (data as { detail?: unknown }).detail;
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail)) {
        const messages = detail
          .map((item) => {
            if (item && typeof item === 'object' && 'msg' in item) return String((item as { msg?: unknown }).msg);
            return typeof item === 'string' ? item : JSON.stringify(item);
          })
          .filter(Boolean);
        if (messages.length) return messages.join(', ');
      }
      if (detail != null) return typeof detail === 'string' ? detail : JSON.stringify(detail);
    }

    if (typeof data === 'string' && data.trim()) return data;
    return err.message;
  }

  if (err instanceof Error) return err.message;
  return String(err);
}

export type HealthResponse = {
  status: string;
  ffmpeg: boolean;
};

export async function checkHealth(): Promise<HealthResponse> {
  const response = await client.get<HealthResponse>('/health');
  return response.data;
}

export type VideoThumbnailResponse = {
  image_base64: string;
};

export type VideoFilmstripRequest = {
  video_path: string;
  num_frames?: number;
};

export type AudioAnalyzeResponse = {
  path: string;
  duration_ms: number;
  sample_rate: number;
  channels: number;
};

export async function analyzeVideo(path: string): Promise<SourceVideo> {
  const form = new FormData();
  form.append('path', path);
  const response = await client.post<SourceVideo>('/media/video/analyze', form);
  return response.data;
}

export async function getVideoThumbnail(path: string, timestamp_ms: number): Promise<VideoThumbnailResponse> {
  try {
    const response = await client.post<VideoThumbnailResponse>('/media/video/thumbnail', {
      path,
      timestamp_ms,
    });
    return response.data;
  } catch (err: unknown) {
    throw new Error(getApiErrorMessage(err));
  }
}

export async function getVideoFilmstrip(video_path: string, num_frames = 20): Promise<string[]> {
  try {
    const response = await client.post<string[]>(
      '/media/video/filmstrip',
      {
        video_path,
        num_frames,
      } satisfies VideoFilmstripRequest,
    );
    return response.data;
  } catch (err: unknown) {
    throw new Error(getApiErrorMessage(err));
  }
}

export async function importMidi(path: string): Promise<MidiData> {
  const form = new FormData();
  form.append('path', path);
  const response = await client.post<MidiData>('/media/midi/import', form);
  return response.data;
}

export async function analyzeAudio(path: string): Promise<AudioAnalyzeResponse> {
  const form = new FormData();
  form.append('path', path);
  const response = await client.post<AudioAnalyzeResponse>('/media/audio/analyze', form);
  return response.data;
}

export type VideoFrameResponse = {
  timestamp_ms: number;
  image_base64: string;
};

export async function getVideoFrame(
  video_path: string,
  timestamp_ms: number,
  max_width = 640,
): Promise<VideoFrameResponse> {
  try {
    const response = await client.post<VideoFrameResponse>('/media/video/frame', {
      video_path,
      timestamp_ms: Math.trunc(timestamp_ms),
      max_width: Math.trunc(max_width),
    });
    return response.data;
  } catch (err: unknown) {
    throw new Error(getApiErrorMessage(err));
  }
}

export type FilmstripSegmentFrame = {
  timestamp_ms: number;
  image_base64: string;
};

export async function getFilmstripSegment(
  video_path: string,
  start_ms: number,
  end_ms: number,
  num_frames = 10,
): Promise<FilmstripSegmentFrame[]> {
  try {
    const response = await client.post<FilmstripSegmentFrame[]>('/media/video/filmstrip-segment', {
      video_path,
      start_ms: Math.trunc(start_ms),
      end_ms: Math.trunc(end_ms),
      num_frames: Math.trunc(num_frames),
    });
    return response.data;
  } catch (err: unknown) {
    throw new Error(getApiErrorMessage(err));
  }
}

export type VideoWaveformResponse = {
  duration_ms: number;
  samples_per_second: number;
  amplitudes: number[];
};

export async function getVideoWaveform(
  video_path: string,
  samples_per_second = 100,
): Promise<VideoWaveformResponse> {
  try {
    const response = await client.post<VideoWaveformResponse>('/media/video/waveform', {
      video_path,
      samples_per_second: Math.trunc(samples_per_second),
    });
    return response.data;
  } catch (err: unknown) {
    throw new Error(getApiErrorMessage(err));
  }
}

// ============ Cache Control API ============

export type CacheStatusResponse = {
  paused: boolean;
  thumbnails_disabled: boolean;
  total_cached: number;
  generating: number;
  ready: number;
};

export async function getCacheStatus(): Promise<CacheStatusResponse> {
  const response = await client.post<CacheStatusResponse>('/media/cache/status');
  return response.data;
}

export async function pauseCache(): Promise<{ paused: boolean; message: string }> {
  const response = await client.post('/media/cache/pause');
  return response.data;
}

export async function resumeCache(): Promise<{ paused: boolean; message: string }> {
  const response = await client.post('/media/cache/resume');
  return response.data;
}

export async function clearCache(video_path?: string): Promise<{ cleared: number; message: string }> {
  const response = await client.post('/media/cache/clear', { video_path: video_path ?? null });
  return response.data;
}

export async function disableThumbnails(): Promise<{ thumbnails_disabled: boolean; cleared: number; message: string }> {
  const response = await client.post('/media/cache/disable-thumbnails');
  return response.data;
}

export async function enableThumbnails(): Promise<{ thumbnails_disabled: boolean; message: string }> {
  const response = await client.post('/media/cache/enable-thumbnails');
  return response.data;
}

export type CompositeFrameRequest = {
  timestamp_ms: number;
  project: Project;
  quality?: 'low' | 'medium';
  midi_data?: MidiData | null;
};

export type CompositeFrameActiveLayer = {
  layer_id: string;
  clip_index: number;
  source_frame_ms: number;
};

export type CompositeFrameResponse = {
  image_base64: string;
  active_layers: CompositeFrameActiveLayer[];
};

export async function getCompositeFrame(
  payload: CompositeFrameRequest,
): Promise<CompositeFrameResponse> {
  try {
    const response = await client.post<CompositeFrameResponse>('/preview/composite-frame', {
      timestamp_ms: Math.trunc(payload.timestamp_ms),
      project: payload.project,
      quality: payload.quality ?? 'medium',
      midi_data: payload.midi_data ?? null,
    } satisfies CompositeFrameRequest);
    return response.data;
  } catch (err: unknown) {
    throw new Error(getApiErrorMessage(err));
  }
}

export type RenderSegmentRequest = {
  start_ms: number;
  duration_ms?: number;
  quality?: 'fast' | 'high';
  project: Project;
  midi_data?: MidiData | null;
};

export type RenderSegmentResponse = {
  video_url: string;
  duration_ms: number;
  width: number;
  height: number;
  fps: number;
};

export async function renderPreviewSegment(
  payload: RenderSegmentRequest,
): Promise<RenderSegmentResponse> {
  try {
    const response = await client.post<RenderSegmentResponse>('/preview/render-segment', {
      start_ms: Math.trunc(payload.start_ms),
      duration_ms: payload.duration_ms ?? 5000,
      quality: payload.quality ?? 'fast',
      project: payload.project,
      midi_data: payload.midi_data ?? null,
    });
    return response.data;
  } catch (err: unknown) {
    throw new Error(getApiErrorMessage(err));
  }
}
