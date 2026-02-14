import { useRef, useEffect, useMemo, useState, useCallback, type ChangeEvent, type PointerEvent } from 'react';
import { getCompositeFrame, renderPreviewSegment, type CompositeFrameActiveLayer } from '../../api/client';
import { useProjectStore } from '../../stores/projectStore';
import type { Layer } from '../../types';

const SEGMENT_DURATION_MS = 5000;

const RESOLUTION_PRESETS: { label: string; value: [number, number] }[] = [
  { label: '360p', value: [640, 360] },
  { label: '480p', value: [854, 480] },
  { label: '720p', value: [1280, 720] },
  { label: '1080p', value: [1920, 1080] },
  { label: '1440p', value: [2560, 1440] },
  { label: '4K', value: [3840, 2160] },
];

const CODEC_OPTIONS: { label: string; value: 'h264' | 'h265' }[] = [
  { label: 'H.264', value: 'h264' },
  { label: 'H.265', value: 'h265' },
];

const LAYER_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f43f5e', // rose
  '#14b8a6', // teal
];

export function PreviewPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playAttemptIdRef = useRef(0);
  const [showGrid, setShowGrid] = useState(true);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const frameCacheRef = useRef(new Map<string, { image_base64: string; active_layers: CompositeFrameActiveLayer[] }>());
  const frameRequestIdRef = useRef(0);
  const frameImageRef = useRef<HTMLImageElement | null>(null);
  const frameImageSrcRef = useRef<string>('');
  const bufferTimeoutRef = useRef<number | null>(null);
  const dragRef = useRef<
    | {
        layerId: string;
        pointerId: number;
        offsetX: number;
        offsetY: number;
      }
    | null
  >(null);

  const project = useProjectStore((s) => s.project);
  const midiData = useProjectStore((s) => s.midiData);
  const bgm = useProjectStore((s) => s.bgm);
  const selectedLayerId = useProjectStore((s) => s.selectedLayerId);
  const selectLayer = useProjectStore((s) => s.selectLayer);
  const updateLayer = useProjectStore((s) => s.updateLayer);
  const updateSettings = useProjectStore((s) => s.updateSettings);
  const previewMode = useProjectStore((s) => s.previewMode);
  const setPreviewMode = useProjectStore((s) => s.setPreviewMode);
  const isScrubbing = useProjectStore((s) => s.isScrubbing);
  const playheadMs = useProjectStore((s) => s.playheadMs);
  const previewFrame = useProjectStore((s) => s.previewFrame);
  const setPreviewFrame = useProjectStore((s) => s.setPreviewFrame);
  const setPlayhead = useProjectStore((s) => s.setPlayhead);

  const playbackState = useProjectStore((s) => s.playbackState);
  const setPlaybackState = useProjectStore((s) => s.setPlaybackState);
  const transportPlaying = useProjectStore((s) => s.transportPlaying);
  const setTransportPlaying = useProjectStore((s) => s.setTransportPlaying);
  const previewQuality = useProjectStore((s) => s.previewQuality);
  const setPreviewQuality = useProjectStore((s) => s.setPreviewQuality);
  const currentSegment = useProjectStore((s) => s.currentSegment);
  const setCurrentSegment = useProjectStore((s) => s.setCurrentSegment);
  const nextSegment = useProjectStore((s) => s.nextSegment);
  const setNextSegment = useProjectStore((s) => s.setNextSegment);
  const incrementBufferRequestId = useProjectStore((s) => s.incrementBufferRequestId);
  const bufferRequestId = useProjectStore((s) => s.bufferRequestId);
  const clearSegments = useProjectStore((s) => s.clearSegments);

  const settings = project?.settings;
  const layers = project?.layers ?? [];
  const outputResolution = settings?.output_resolution ?? [1920, 1080];
  const globalGrid = settings?.global_grid ?? [3, 3];
  const snapToGrid = settings?.snap_to_grid ?? true;
  const snapSubdivisions = Math.max(1, Math.trunc(settings?.snap_subdivisions ?? 1));
  const midiDurationMs = useMemo(() => {
    if (!midiData) return Number.POSITIVE_INFINITY;
    let maxEnd = 0;
    for (const notes of Object.values(midiData.channels)) {
      for (const note of notes) {
        const end = Number.isFinite(note.end_ms) ? note.end_ms : note.start_ms + note.duration_ms;
        if (end > maxEnd) maxEnd = end;
      }
    }
    const fallback = Number.isFinite(midiData.duration_ms) ? midiData.duration_ms : 0;
    return Math.max(maxEnd, fallback);
  }, [midiData]);

  const clampToMidi = useCallback(
    (ms: number) => {
      const safe = Math.max(0, Math.trunc(ms));
      if (!Number.isFinite(midiDurationMs)) return safe;
      return Math.max(0, Math.min(Math.trunc(midiDurationMs), safe));
    },
    [midiDurationMs]
  );

  const toFileUrl = useCallback((path: string) => {
    if (!path) return '';
    if (path.startsWith('file://')) return path;
    const normalized = path.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(normalized)) {
      return `file:///${encodeURI(normalized)}`;
    }
    return `file://${encodeURI(normalized)}`;
  }, []);

  const quantizePreviewMs = useCallback(
    (ms: number, quality: 'low' | 'medium') => {
      const q = quality === 'low' ? 200 : 80;
      const t = Math.max(0, Math.trunc(ms));
      return Math.round(t / q) * q;
    },
    []
  );

  useEffect(() => {
    frameCacheRef.current.clear();
    frameImageRef.current = null;
    frameImageSrcRef.current = '';
  }, [project, midiData]);

  useEffect(() => {
    if (!project || !midiData) return;
    if (previewMode !== 'timeline') return;

    const quality = isScrubbing ? 'low' : 'medium';
    const tMs = quantizePreviewMs(playheadMs, quality);
    const key = `${quality}|${tMs}`;
    const cached = frameCacheRef.current.get(key);
    if (cached) {
      setPreviewFrame({
        timestamp_ms: tMs,
        quality,
        image_base64: cached.image_base64,
        active_layers: cached.active_layers ?? [],
      });
      return;
    }

    const requestId = (frameRequestIdRef.current += 1);
    const timeout = window.setTimeout(() => {
      void getCompositeFrame({
        timestamp_ms: tMs,
        project,
        quality,
        midi_data: midiData,
      })
        .then((res) => {
          if (frameRequestIdRef.current !== requestId) return;
          frameCacheRef.current.set(key, { image_base64: res.image_base64, active_layers: res.active_layers });
          while (frameCacheRef.current.size > 50) {
            const first = frameCacheRef.current.keys().next().value;
            if (first) frameCacheRef.current.delete(first);
            else break;
          }
          setPreviewFrame({
            timestamp_ms: tMs,
            quality,
            image_base64: res.image_base64,
            active_layers: res.active_layers,
          });
        })
        .catch((err) => {
          console.error('[PreviewPanel] Failed to fetch composite frame:', err);
        });
    }, isScrubbing ? 220 : 260);

    return () => window.clearTimeout(timeout);
  }, [isScrubbing, midiData, playheadMs, previewMode, project, quantizePreviewMs, setPreviewFrame]);

  const clamp = useCallback((value: number, min: number, max: number) => {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }, []);

  const resolveLayerGrid = useCallback(
    (layer: Layer): [number, number] => {
      const raw = layer.use_global_grid ? globalGrid : layer.custom_grid ?? globalGrid;
      const cols = Math.max(1, Math.trunc(raw[0] ?? 1));
      const rows = Math.max(1, Math.trunc(raw[1] ?? 1));
      return [cols, rows];
    },
    [globalGrid]
  );

  const getLayerRect = useCallback(
    (layer: Layer, width: number, height: number) => {
      const [cols, rows] = resolveLayerGrid(layer);
      const cellWidth = width / cols;
      const cellHeight = height / rows;
      const [colRaw, rowRaw] = layer.grid_position;
      const col = clamp(Number(colRaw), 0, cols - 1);
      const row = clamp(Number(rowRaw), 0, rows - 1);
      return {
        x: col * cellWidth,
        y: row * cellHeight,
        w: cellWidth,
        h: cellHeight,
      };
    },
    [clamp, resolveLayerGrid]
  );

  // Resize canvas to fit container while maintaining 16:9
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const containerWidth = entry.contentRect.width;
      const containerHeight = entry.contentRect.height;

      // Calculate size that fits in container with 16:9 aspect
      const aspectRatio = 16 / 9;
      let width = containerWidth;
      let height = width / aspectRatio;

      if (height > containerHeight) {
        height = containerHeight;
        width = height * aspectRatio;
      }

      setCanvasSize({ width: Math.floor(width), height: Math.floor(height) });
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Draw the preview
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvasSize;
    if (width === 0 || height === 0) return;

    if (previewMode === 'timeline' && previewFrame) {
      const src = `data:image/png;base64,${previewFrame.image_base64}`;
      if (frameImageSrcRef.current !== src) {
        frameImageSrcRef.current = src;
        const img = new Image();
        frameImageRef.current = img;
        img.onload = () => {
          draw();
        };
        img.src = src;
      }

      ctx.clearRect(0, 0, width, height);
      const img = frameImageRef.current;
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, 0, 0, width, height);
      } else {
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, width, height);
      }

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0, 0, width, height);
      return;
    }

    // Clear and draw background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // Draw checkerboard pattern for transparency indication
    const checkSize = 10;
    ctx.fillStyle = '#252525';
    for (let y = 0; y < height; y += checkSize * 2) {
      for (let x = 0; x < width; x += checkSize * 2) {
        ctx.fillRect(x, y, checkSize, checkSize);
        ctx.fillRect(x + checkSize, y + checkSize, checkSize, checkSize);
      }
    }

    const cols = Math.max(1, Math.trunc(globalGrid[0] ?? 1));
    const rows = Math.max(1, Math.trunc(globalGrid[1] ?? 1));
    const cellWidth = width / cols;
    const cellHeight = height / rows;

    // Draw layer rectangles
    const enabledLayers = layers.filter((l) => l.enabled);
    enabledLayers.forEach((layer, index) => {
      const rect = getLayerRect(layer, width, height);
      const x = rect.x;
      const y = rect.y;
      const rw = rect.w;
      const rh = rect.h;
      const color = LAYER_COLORS[index % LAYER_COLORS.length];
      const isSelected = layer.id === selectedLayerId;

      // Fill with semi-transparent color
      ctx.fillStyle = color + '40'; // 25% opacity
      ctx.fillRect(x + 2, y + 2, rw - 4, rh - 4);

      // Border
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 3 : 1.5;
      ctx.strokeRect(x + 2, y + 2, rw - 4, rh - 4);

      // Layer name/number
      ctx.fillStyle = '#ffffff';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const label = layer.name || `Layer ${index + 1}`;
      ctx.fillText(label, x + 6, y + 6);
    });

    // Draw grid overlay
    if (showGrid) {
      ctx.lineWidth = 1;

      if (snapToGrid && snapSubdivisions > 1) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';

        const subCols = cols * snapSubdivisions;
        const subRows = rows * snapSubdivisions;

        // Subdivision vertical lines (skip major lines)
        for (let i = 1; i < subCols; i += 1) {
          if (i % snapSubdivisions === 0) continue;
          const x = (i * cellWidth) / snapSubdivisions;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }

        // Subdivision horizontal lines (skip major lines)
        for (let i = 1; i < subRows; i += 1) {
          if (i % snapSubdivisions === 0) continue;
          const y = (i * cellHeight) / snapSubdivisions;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }
      }

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';

      // Vertical lines
      for (let i = 1; i < cols; i++) {
        const x = i * cellWidth;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      // Horizontal lines
      for (let i = 1; i < rows; i++) {
        const y = i * cellHeight;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Column labels
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let i = 0; i < cols; i++) {
        const x = i * cellWidth + cellWidth / 2;
        ctx.fillText(String(i), x, 4);
      }

      // Row labels
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < rows; i++) {
        const y = i * cellHeight + cellHeight / 2;
        ctx.fillText(String(i), 4, y);
      }
    }

    // Draw border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, width, height);
  }, [
    canvasSize,
    getLayerRect,
    globalGrid,
    layers,
    previewFrame,
    previewMode,
    selectedLayerId,
    showGrid,
    snapSubdivisions,
    snapToGrid,
  ]);

  useEffect(() => {
    draw();
  }, [draw]);

  const findTopmostLayerAtPoint = useCallback(
    (x: number, y: number) => {
      const enabledLayers = layers.filter((l) => l.enabled);
      for (let i = enabledLayers.length - 1; i >= 0; i -= 1) {
        const layer = enabledLayers[i];
        if (!layer) continue;
        const rect = getLayerRect(layer, canvasSize.width, canvasSize.height);
        if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
          return layer;
        }
      }
      return null;
    },
    [canvasSize.height, canvasSize.width, getLayerRect, layers]
  );

  const setLayerPositionFromCanvasPoint = useCallback(
    (layer: Layer, canvasX: number, canvasY: number, offsetX: number, offsetY: number) => {
      const [cols, rows] = resolveLayerGrid(layer);
      const cellWidth = canvasSize.width / cols;
      const cellHeight = canvasSize.height / rows;

      const rawCol = (canvasX - offsetX) / cellWidth;
      const rawRow = (canvasY - offsetY) / cellHeight;

      let col = rawCol;
      let row = rawRow;

      if (snapToGrid) {
        const sub = Math.max(1, snapSubdivisions);
        col = Math.round(col * sub) / sub;
        row = Math.round(row * sub) / sub;
      }

      col = clamp(col, 0, cols - 1);
      row = clamp(row, 0, rows - 1);

      updateLayer(layer.id, { grid_position: [col, row] });
    },
    [clamp, canvasSize.height, canvasSize.width, resolveLayerGrid, snapSubdivisions, snapToGrid, updateLayer]
  );

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      if (previewMode === 'timeline') return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const hit = findTopmostLayerAtPoint(x, y);
      if (!hit) return;

      selectLayer(hit.id);

      const hitRect = getLayerRect(hit, canvasSize.width, canvasSize.height);
      const offsetX = x - hitRect.x;
      const offsetY = y - hitRect.y;

      dragRef.current = {
        layerId: hit.id,
        pointerId: e.pointerId,
        offsetX,
        offsetY,
      };
      setDraggingLayerId(hit.id);
      canvas.setPointerCapture(e.pointerId);
    },
    [canvasSize.height, canvasSize.width, findTopmostLayerAtPoint, getLayerRect, previewMode, selectLayer]
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      if (previewMode === 'timeline') return;
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.pointerId !== e.pointerId) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const layer = layers.find((l) => l.id === drag.layerId) ?? null;
      if (!layer) return;

      setLayerPositionFromCanvasPoint(layer, x, y, drag.offsetX, drag.offsetY);
    },
    [layers, previewMode, setLayerPositionFromCanvasPoint]
  );

  const endDrag = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      setDraggingLayerId(null);
    },
    []
  );

  const handleResolutionChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const preset = RESOLUTION_PRESETS.find((p) => p.label === e.target.value);
    if (preset) {
      updateSettings({ output_resolution: preset.value });
    }
  };

  const handleCodecChange = (e: ChangeEvent<HTMLSelectElement>) => {
    updateSettings({ output_codec: e.target.value as 'h264' | 'h265' });
  };

  const handleGlobalGridColsChange = (e: ChangeEvent<HTMLInputElement>) => {
    const nextCols = Math.trunc(Number(e.target.value));
    if (!Number.isFinite(nextCols) || nextCols < 1) return;
    const rows = Math.max(1, Math.trunc(globalGrid[1] ?? 1));
    updateSettings({ global_grid: [nextCols, rows] });
  };

  const handleGlobalGridRowsChange = (e: ChangeEvent<HTMLInputElement>) => {
    const nextRows = Math.trunc(Number(e.target.value));
    if (!Number.isFinite(nextRows) || nextRows < 1) return;
    const cols = Math.max(1, Math.trunc(globalGrid[0] ?? 1));
    updateSettings({ global_grid: [cols, nextRows] });
  };

  const handleSnapToGridChange = (e: ChangeEvent<HTMLInputElement>) => {
    updateSettings({ snap_to_grid: e.target.checked });
  };

  const handleSnapSubdivisionsChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = Math.trunc(Number(e.target.value));
    if (!Number.isFinite(next) || next < 1) return;
    updateSettings({ snap_subdivisions: next });
  };

  const currentResolutionLabel =
    RESOLUTION_PRESETS.find(
      (p) => p.value[0] === outputResolution[0] && p.value[1] === outputResolution[1]
    )?.label ?? 'Custom';

  const renderSegmentAt = useCallback(
    async (startMs: number, quality: 'fast' | 'high', requestId: number) => {
      if (!project || !midiData) return null;
      try {
        const clampedStartMs = clampToMidi(startMs);
        const res = await renderPreviewSegment({
          start_ms: clampedStartMs,
          duration_ms: SEGMENT_DURATION_MS,
          quality,
          project,
          midi_data: midiData,
        });
        const currentReqId = useProjectStore.getState().bufferRequestId;
        if (currentReqId !== requestId) return null;
        return {
          url: `http://localhost:8765${res.video_url}`,
          startMs: clampedStartMs,
          durationMs: res.duration_ms,
          quality,
        };
      } catch (err) {
        const currentReqId = useProjectStore.getState().bufferRequestId;
        if (currentReqId === requestId) {
          setRenderError(err instanceof Error ? err.message : String(err));
        }
        return null;
      }
    },
    [clampToMidi, midiData, project]
  );

  const bufferSegments = useCallback(
    async (fromMs: number) => {
      if (!project || !midiData) return;
      const clampedFromMs = clampToMidi(fromMs);
      if (Number.isFinite(midiDurationMs) && clampedFromMs >= midiDurationMs) {
        setPlaybackState('idle');
        setTransportPlaying(false);
        return;
      }
      const reqId = incrementBufferRequestId();
      setPlaybackState('rendering');
      setRenderError(null);

      const seg = await renderSegmentAt(clampedFromMs, previewQuality, reqId);
      if (!seg) {
        const currentReqId = useProjectStore.getState().bufferRequestId;
        if (currentReqId === reqId) setPlaybackState('idle');
        return;
      }
      setCurrentSegment(seg);
      setPlaybackState('ready');

      const nextStartMs = seg.startMs + SEGMENT_DURATION_MS;
      if (!Number.isFinite(midiDurationMs) || nextStartMs < midiDurationMs) {
        const nextSeg = await renderSegmentAt(nextStartMs, previewQuality, reqId);
        if (nextSeg) {
          setNextSegment(nextSeg);
        }
      } else {
        setNextSegment(null);
      }
    },
    [clampToMidi, incrementBufferRequestId, midiData, midiDurationMs, previewQuality, project, renderSegmentAt, setCurrentSegment, setNextSegment, setPlaybackState, setTransportPlaying]
  );

  const handleVideoTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !currentSegment) return;
    const currentTimeMs = currentSegment.startMs + video.currentTime * 1000;
    const clamped = clampToMidi(currentTimeMs);
    setPlayhead(Math.trunc(clamped));
    if (Number.isFinite(midiDurationMs) && clamped >= midiDurationMs) {
      video.pause();
      audioRef.current?.pause();
      setTransportPlaying(false);
      setPlaybackState('ready');
    }
  }, [clampToMidi, currentSegment, midiDurationMs, setPlayhead, setPlaybackState, setTransportPlaying]);

  const handleVideoEnded = useCallback(() => {
    if (!transportPlaying) {
      setPlaybackState('ready');
      return;
    }

    if (nextSegment && (!Number.isFinite(midiDurationMs) || nextSegment.startMs < midiDurationMs)) {
      setCurrentSegment(nextSegment);
      setNextSegment(null);
      setPlaybackState('ready');
      const nextStartMs = nextSegment.startMs + SEGMENT_DURATION_MS;
      const reqId = incrementBufferRequestId();
      if (!Number.isFinite(midiDurationMs) || nextStartMs < midiDurationMs) {
        void renderSegmentAt(nextStartMs, previewQuality, reqId).then((seg) => {
          if (seg) setNextSegment(seg);
        });
      }
    } else {
      audioRef.current?.pause();
      setTransportPlaying(false);
      setPlaybackState('ready');
    }
  }, [incrementBufferRequestId, midiDurationMs, nextSegment, previewQuality, renderSegmentAt, setCurrentSegment, setNextSegment, setPlaybackState, setTransportPlaying, transportPlaying]);

  const syncBgmToPlayhead = useCallback((headMs: number, play: boolean) => {
    const audio = audioRef.current;
    if (!audio || !bgm) return;
    const bgmOffset = project?.bgm_offset_ms ?? 0;
    const audioTimeS = Math.max(0, (headMs - bgmOffset) / 1000);
    audio.currentTime = audioTimeS;
    if (play) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [bgm, project?.bgm_offset_ms]);

  const togglePlayback = useCallback(() => {
    const state = useProjectStore.getState();
    const headMs = clampToMidi(state.playheadMs);

    if (state.transportPlaying) {
      // STOP
      playAttemptIdRef.current += 1;
      setTransportPlaying(false);
      videoRef.current?.pause();
      syncBgmToPlayhead(headMs, false);
      setPlaybackState('ready');
      return;
    }

    // PLAY
    setTransportPlaying(true);
    const segment = state.currentSegment;
    if (!segment) {
      void bufferSegments(headMs);
      return;
    }
    const segmentEnd = segment.startMs + segment.durationMs;
    if (headMs < segment.startMs || headMs >= segmentEnd) {
      void bufferSegments(headMs);
      return;
    }
    setPlaybackState('ready');
  }, [bufferSegments, clampToMidi, setPlaybackState, setTransportPlaying, syncBgmToPlayhead]);

  useEffect(() => {
    if (!transportPlaying) return;
    if (isScrubbing) return;
    if (playbackState !== 'ready') return;
    if (!currentSegment) return;
    const headMs = clampToMidi(playheadMs);
    const segmentEnd = currentSegment.startMs + currentSegment.durationMs;
    if (headMs < currentSegment.startMs || headMs >= segmentEnd) {
      void bufferSegments(headMs);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, (headMs - currentSegment.startMs) / 1000);
    const attemptId = (playAttemptIdRef.current += 1);
    video
      .play()
      .then(() => {
        if (playAttemptIdRef.current !== attemptId) {
          video.pause();
          return;
        }
        if (!useProjectStore.getState().transportPlaying) {
          video.pause();
          return;
        }
        syncBgmToPlayhead(headMs, true);
        setPlaybackState('playing');
      })
      .catch(() => {
        if (playAttemptIdRef.current !== attemptId) return;
        audioRef.current?.pause();
        setTransportPlaying(false);
        setPlaybackState('ready');
      });
  }, [bufferSegments, clampToMidi, currentSegment, isScrubbing, playbackState, playheadMs, setPlaybackState, syncBgmToPlayhead, transportPlaying]);

  useEffect(() => {
    if (previewMode !== 'timeline') return;
    if (playbackState === 'playing' || playbackState === 'rendering') return;
    if (!project || !midiData) return;

    if (bufferTimeoutRef.current) {
      window.clearTimeout(bufferTimeoutRef.current);
    }

    bufferTimeoutRef.current = window.setTimeout(() => {
      if (
        !currentSegment ||
        playheadMs < currentSegment.startMs ||
        playheadMs >= currentSegment.startMs + currentSegment.durationMs
      ) {
        void bufferSegments(playheadMs);
      }
    }, 400);

    return () => {
      if (bufferTimeoutRef.current) {
        window.clearTimeout(bufferTimeoutRef.current);
      }
    };
  }, [bufferSegments, currentSegment, midiData, playbackState, playheadMs, previewMode, project]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (e.repeat) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (previewMode !== 'timeline') return;
      e.preventDefault();
      e.stopPropagation();
      togglePlayback();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [previewMode, togglePlayback]);

  useEffect(() => {
    if (isScrubbing && (playbackState === 'playing' || transportPlaying)) {
      playAttemptIdRef.current += 1;
      videoRef.current?.pause();
      audioRef.current?.pause();
      setPlaybackState('ready');
    }
  }, [isScrubbing, playbackState, setPlaybackState, transportPlaying]);

  const isVideoMounted = previewMode === 'timeline' && (playbackState === 'playing' || playbackState === 'ready') && currentSegment;
  const isVideoOnTop = previewMode === 'timeline' && playbackState === 'playing' && currentSegment;

  return (
    <div className="h-full w-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-white">Preview</div>
          <div className="text-xs text-gray-400 bg-white/5 px-2 py-0.5 rounded">
            {outputResolution[0]}×{outputResolution[1]}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPreviewMode('grid')}
            className={
              previewMode === 'grid'
                ? 'text-xs px-2 py-1 rounded bg-srve-accent/20 text-srve-accent border border-srve-accent/30'
                : 'text-xs px-2 py-1 rounded bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10'
            }
          >
            Grid
          </button>
          <button
            type="button"
            onClick={() => setPreviewMode('timeline')}
            className={
              previewMode === 'timeline'
                ? 'text-xs px-2 py-1 rounded bg-srve-accent/20 text-srve-accent border border-srve-accent/30'
                : 'text-xs px-2 py-1 rounded bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10'
            }
          >
            Timeline
          </button>
          <div className="text-xs text-gray-400">16:9</div>
        </div>
      </div>

      {/* Canvas/Video container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 flex items-center justify-center bg-black/20 rounded-lg p-2 relative"
      >
        <canvas
          ref={canvasRef}
          width={canvasSize.width}
          height={canvasSize.height}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className={`rounded ${draggingLayerId ? 'cursor-grabbing' : 'cursor-grab'} ${isVideoOnTop ? 'invisible' : ''}`}
          style={{ width: canvasSize.width, height: canvasSize.height }}
        />
        {isVideoMounted && currentSegment && (
          <video
            ref={videoRef}
            src={currentSegment.url}
            onTimeUpdate={handleVideoTimeUpdate}
            onEnded={handleVideoEnded}
            className={`absolute inset-0 m-auto rounded object-contain ${isVideoOnTop ? '' : 'invisible'}`}
            style={{ maxWidth: canvasSize.width, maxHeight: canvasSize.height }}
          />
        )}
        {playbackState === 'rendering' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded">
            <div className="flex items-center gap-2 text-white text-sm">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span>Rendering preview...</span>
            </div>
          </div>
        )}
      </div>

      {renderError && (
        <div className="mt-2 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
          {renderError}
        </div>
      )}

      {bgm && (
        <audio ref={audioRef} src={toFileUrl(bgm.path)} preload="auto" />
      )}

      {/* Controls */}
      <div className="flex items-center justify-between mt-3 gap-4">
        {/* Show Grid toggle */}
        <button
          onClick={() => {
            if (previewMode === 'timeline') return;
            setShowGrid(!showGrid);
          }}
          disabled={previewMode === 'timeline'}
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
            showGrid
              ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
              : 'bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          <span>{showGrid ? 'Hide Grid' : 'Show Grid'}</span>
        </button>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400">Grid:</label>
            <input
              type="number"
              min={1}
              value={Math.max(1, Math.trunc(globalGrid[0] ?? 1))}
              onChange={handleGlobalGridColsChange}
              className="w-16 bg-srve-panel border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
            />
            <span className="text-xs text-gray-500">×</span>
            <input
              type="number"
              min={1}
              value={Math.max(1, Math.trunc(globalGrid[1] ?? 1))}
              onChange={handleGlobalGridRowsChange}
              className="w-16 bg-srve-panel border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          <label className="flex items-center gap-2 rounded bg-white/5 border border-white/10 px-2 py-1">
            <span className="text-xs text-gray-300">Snap</span>
            <input
              type="checkbox"
              checked={snapToGrid}
              onChange={handleSnapToGridChange}
              className="accent-srve-accent"
            />
          </label>

          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400">Subdiv:</label>
            <input
              type="number"
              min={1}
              value={snapSubdivisions}
              disabled={!snapToGrid}
              onChange={handleSnapSubdivisionsChange}
              className="w-16 bg-srve-panel border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-60"
            />
          </div>

          {/* Resolution dropdown */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400">Resolution:</label>
            <select
              value={currentResolutionLabel}
              onChange={handleResolutionChange}
              className="bg-srve-panel border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
            >
              {RESOLUTION_PRESETS.map((preset) => (
                <option key={preset.label} value={preset.label}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>

          {/* Codec dropdown */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400">Codec:</label>
            <select
              value={settings?.output_codec ?? 'h264'}
              onChange={handleCodecChange}
              className="bg-srve-panel border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
            >
              {CODEC_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
