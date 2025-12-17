import { create } from 'zustand';
import type { Layer, MidiData, Project, ProjectSettings, SourceVideo } from '../types';
import { EasingType, FlipMode } from '../types';

type BgmTrack = {
  path: string;
  duration_ms: number;
};

type PreviewActiveLayer = {
  layer_id: string;
  clip_index: number;
  source_frame_ms: number;
};

type PreviewFrame = {
  timestamp_ms: number;
  quality: 'low' | 'medium';
  image_base64: string;
  active_layers: PreviewActiveLayer[];
};

type PreviewSegment = {
  url: string;
  startMs: number;
  durationMs: number;
  quality: 'fast' | 'high';
};

type PlaybackState = 'idle' | 'rendering' | 'ready' | 'playing';

interface ProjectStoreState {
  project: Project | null;
  midiData: MidiData | null;
  bgm: BgmTrack | null;
  chorusVideo: SourceVideo | null;
  selectedLayerId: string | null;
  isModified: boolean;
  playheadMs: number;

  previewMode: 'grid' | 'timeline';
  isScrubbing: boolean;
  previewFrame: PreviewFrame | null;

  playbackState: PlaybackState;
  transportPlaying: boolean;
  previewQuality: 'fast' | 'high';
  currentSegment: PreviewSegment | null;
  nextSegment: PreviewSegment | null;
  bufferRequestId: number;

  setPlaybackState: (state: PlaybackState) => void;
  setTransportPlaying: (playing: boolean) => void;
  setPreviewQuality: (quality: 'fast' | 'high') => void;
  setCurrentSegment: (segment: PreviewSegment | null) => void;
  setNextSegment: (segment: PreviewSegment | null) => void;
  incrementBufferRequestId: () => number;
  clearSegments: () => void;

  newProject: () => void;
  loadProject: (project: Project) => void;
  updateSettings: (settings: Partial<ProjectSettings>) => void;
  addLayer: () => string;
  duplicateLayer: (id: string) => string;
  removeLayer: (id: string) => void;
  updateLayer: (id: string, updates: Partial<Layer>) => void;
  reorderLayers: (orderedIds: string[]) => void;
  selectLayer: (id: string | null) => void;
  addSourceVideo: (video: SourceVideo) => void;
  removeSourceVideo: (id: string) => void;
  setMidiData: (data: MidiData | null) => void;
  setMidiFilePath: (path: string | null) => void;
  setBgm: (bgm: BgmTrack | null) => void;
  setChorusVideo: (video: SourceVideo | null) => void;
  setBgmOffset: (offsetMs: number) => void;
  setChorusOffset: (offsetMs: number) => void;
  setBpm: (bpm: number | null) => void;
  setPlayhead: (ms: number) => void;
  setPreviewMode: (mode: 'grid' | 'timeline') => void;
  setScrubbing: (scrubbing: boolean) => void;
  setPreviewFrame: (frame: PreviewFrame | null) => void;
  setModified: (modified: boolean) => void;
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function createDefaultProjectSettings(): ProjectSettings {
  return {
    output_resolution: [1920, 1080],
    output_codec: 'h264',
    output_audio_bitrate: 320,
    preview_quality: 'low',
    global_grid: [3, 3],
    snap_to_grid: true,
    snap_subdivisions: 1,
  };
}

function createEmptyProject(): Project {
  return {
    version: '1.0',
    name: 'Untitled Project',
    settings: createDefaultProjectSettings(),
    source_videos: [],
    layers: [],
    midi_file_path: null,
    bgm_path: null,
    bgm_offset_ms: 0,
    chorus_video_path: null,
    chorus_offset_ms: 0,
    bpm: null,
  };
}

function createDefaultLayer(order: number): Layer {
  return {
    id: generateId(),
    name: `Layer ${order + 1}`,
    source_video_id: null,
    midi_channel: 1,
    clip_settings: {
      in_point_ms: 0,
      out_point_ms: -1,
      loop_mode: 'freeze',
      crossfade_percent: 10.0,
    },
    grid_position: [0, 0],
    use_global_grid: true,
    custom_grid: null,
    flip_mode: FlipMode.NONE,
    velocity_opacity: true,
    note_length_mode: 'midi',
    effects: {
      black_and_white: false,
      wave_enabled: false,
      wave_amplitude: 10.0,
      wave_frequency: 2.0,
      wave_speed: 1.0,
      zoom: {
        enabled: false,
        start_scale: 1.0,
        end_scale: 1.2,
        easing: EasingType.LINEAR,
        easing_intensity: 1.0,
      },
    },
    order,
    enabled: true,
  };
}

function deepCloneLayer(layer: Layer): Layer {
  if (typeof structuredClone === 'function') {
    return structuredClone(layer);
  }
  return JSON.parse(JSON.stringify(layer)) as Layer;
}

function createDuplicateName(existingNames: Set<string>, base: string): string {
  if (!existingNames.has(base)) return base;

  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  project: createEmptyProject(),
  midiData: null,
  bgm: null,
  chorusVideo: null,
  selectedLayerId: null,
  isModified: false,
  playheadMs: 0,

  previewMode: 'grid',
  isScrubbing: false,
  previewFrame: null,

  playbackState: 'idle',
  transportPlaying: false,
  previewQuality: 'fast',
  currentSegment: null,
  nextSegment: null,
  bufferRequestId: 0,

  setPlaybackState: (state) => set({ playbackState: state }),
  setTransportPlaying: (playing) => set({ transportPlaying: !!playing }),
  setPreviewQuality: (quality) => set({ previewQuality: quality }),
  setCurrentSegment: (segment) => set({ currentSegment: segment }),
  setNextSegment: (segment) => set({ nextSegment: segment }),
  incrementBufferRequestId: () => {
    const next = get().bufferRequestId + 1;
    set({ bufferRequestId: next });
    return next;
  },
  clearSegments: () => set({ currentSegment: null, nextSegment: null, playbackState: 'idle', transportPlaying: false }),

  newProject: () =>
    set({
      project: createEmptyProject(),
      midiData: null,
      bgm: null,
      chorusVideo: null,
      selectedLayerId: null,
      isModified: false,
      playheadMs: 0,
      previewFrame: null,
      isScrubbing: false,
      previewMode: 'grid',
      playbackState: 'idle',
      transportPlaying: false,
      currentSegment: null,
      nextSegment: null,
    }),

  loadProject: (project) =>
    set({
      project,
      midiData: null,
      bgm: project.bgm_path ? { path: project.bgm_path, duration_ms: 0 } : null,
      chorusVideo: null,
      selectedLayerId: null,
      isModified: false,
      playheadMs: 0,
      previewFrame: null,
      isScrubbing: false,
      previewMode: 'grid',
      playbackState: 'idle',
      transportPlaying: false,
      currentSegment: null,
      nextSegment: null,
    }),

  updateSettings: (settings) =>
    set((state) => {
      if (!state.project) return state;
      return {
        project: {
          ...state.project,
          settings: {
            ...state.project.settings,
            ...settings,
          },
        },
        isModified: true,
      };
    }),

  addLayer: () => {
    const project = get().project;
    if (!project) {
      const empty = createEmptyProject();
      const layer = createDefaultLayer(0);
      set({
        project: { ...empty, layers: [layer] },
        selectedLayerId: layer.id,
        isModified: true,
      });
      return layer.id;
    }

    const maxOrder = project.layers.reduce((acc, l) => Math.max(acc, l.order), -1);
    const newOrder = maxOrder + 1;
    const layer = createDefaultLayer(newOrder);
    set({
      project: {
        ...project,
        layers: [...project.layers, layer],
      },
      selectedLayerId: layer.id,
      isModified: true,
    });
    return layer.id;
  },

  duplicateLayer: (id) => {
    const project = get().project;
    if (!project) return '';

    const original = project.layers.find((l) => l.id === id);
    if (!original) return '';

    const maxOrder = project.layers.reduce((acc, l) => Math.max(acc, l.order), -1);
    const copy = deepCloneLayer(original);
    copy.id = generateId();
    copy.order = maxOrder + 1;

    const existingNames = new Set(project.layers.map((l) => l.name));
    copy.name = createDuplicateName(existingNames, `${original.name} Copy`);

    set({
      project: {
        ...project,
        layers: [...project.layers, copy],
      },
      selectedLayerId: copy.id,
      isModified: true,
    });

    return copy.id;
  },

  removeLayer: (id) =>
    set((state) => {
      if (!state.project) return state;

      const layers = state.project.layers.filter((l) => l.id !== id);
      const selectedLayerId = state.selectedLayerId === id ? null : state.selectedLayerId;
      return {
        project: {
          ...state.project,
          layers,
        },
        selectedLayerId,
        isModified: true,
      };
    }),

  updateLayer: (id, updates) =>
    set((state) => {
      if (!state.project) return state;
      return {
        project: {
          ...state.project,
          layers: state.project.layers.map((layer) =>
            layer.id === id
              ? {
                  ...layer,
                  ...updates,
                }
              : layer,
          ),
        },
        isModified: true,
      };
    }),

  reorderLayers: (orderedIds) =>
    set((state) => {
      if (!state.project) return state;

      const byId = new Map(state.project.layers.map((l) => [l.id, l] as const));
      const reordered: Layer[] = [];

      orderedIds.forEach((id, index) => {
        const layer = byId.get(id);
        if (!layer) return;
        reordered.push({
          ...layer,
          order: index,
        });
      });

      state.project.layers.forEach((layer) => {
        if (orderedIds.includes(layer.id)) return;
        reordered.push({
          ...layer,
          order: reordered.length,
        });
      });

      return {
        project: {
          ...state.project,
          layers: reordered,
        },
        isModified: true,
      };
    }),

  selectLayer: (id) => set({ selectedLayerId: id }),

  addSourceVideo: (video) =>
    set((state) => {
      if (!state.project) return state;

      const normalized = video.path.toLowerCase();
      const exists = state.project.source_videos.some((v) => v.path.toLowerCase() === normalized);
      if (exists) {
        return state;
      }

      return {
        project: {
          ...state.project,
          source_videos: [...state.project.source_videos, video],
        },
        isModified: true,
      };
    }),

  removeSourceVideo: (id) =>
    set((state) => {
      if (!state.project) return state;
      return {
        project: {
          ...state.project,
          source_videos: state.project.source_videos.filter((v) => v.id !== id),
        },
        isModified: true,
      };
    }),

  setMidiData: (data) => set({ midiData: data, isModified: true }),

  setMidiFilePath: (path) =>
    set((state) => {
      if (!state.project) return state;
      return {
        project: {
          ...state.project,
          midi_file_path: path,
        },
        isModified: true,
      };
    }),

  setBgm: (bgm) =>
    set((state) => {
      if (!state.project) return state;
      return {
        bgm,
        project: {
          ...state.project,
          bgm_path: bgm ? bgm.path : null,
        },
        isModified: true,
      };
    }),

  setChorusVideo: (video) =>
    set((state) => {
      if (!state.project) return state;
      return {
        chorusVideo: video,
        project: {
          ...state.project,
          chorus_video_path: video ? video.path : null,
        },
        isModified: true,
      };
    }),

  setBgmOffset: (offsetMs) =>
    set((state) => {
      if (!state.project) return state;
      const value = Number.isFinite(offsetMs) ? Math.trunc(offsetMs) : 0;
      return {
        project: {
          ...state.project,
          bgm_offset_ms: value,
        },
        isModified: true,
      };
    }),

  setChorusOffset: (offsetMs) =>
    set((state) => {
      if (!state.project) return state;
      const value = Number.isFinite(offsetMs) ? Math.trunc(offsetMs) : 0;
      return {
        project: {
          ...state.project,
          chorus_offset_ms: value,
        },
        isModified: true,
      };
    }),

  setBpm: (bpm) =>
    set((state) => {
      if (!state.project) return state;
      return {
        project: {
          ...state.project,
          bpm,
        },
        isModified: true,
      };
    }),

  setPlayhead: (ms) => set({ playheadMs: ms }),

  setPreviewMode: (mode) => set({ previewMode: mode }),

  setScrubbing: (scrubbing) => set({ isScrubbing: !!scrubbing }),

  setPreviewFrame: (frame) => set({ previewFrame: frame }),

  setModified: (modified) => set({ isModified: modified }),
}));
