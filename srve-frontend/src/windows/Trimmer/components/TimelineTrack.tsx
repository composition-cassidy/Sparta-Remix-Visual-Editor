import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getCacheStatus, getFilmstripSegment, type VideoWaveformResponse } from '../../../api/client';

type TimelineTrackProps = {
  videoPath: string;
  duration: number;
  inPoint: number;
  outPoint: number;
  playhead: number;
  zoom: number;
  scrollOffset: number;
  waveform: VideoWaveformResponse | null;
  thumbnailsEnabled?: boolean;  // Optional prop to control thumbnails
  onInPointChange: (ms: number) => void;
  onOutPointChange: (ms: number) => void;
  onPlayheadChange: (ms: number) => void;
  onScrollChange: (offset: number) => void;
  onZoomChange: (zoom: number) => void;
};

type FilmstripFrame = {
  timestamp_ms: number;
  image_base64: string;
};

type CachedFrame = {
  timestamp_ms: number;
  image: HTMLImageElement | null;
  loading: boolean;
};

// Global frame cache to persist across re-renders
const frameCache = new Map<string, CachedFrame>();
const MAX_CACHE_SIZE = 200;

function getCacheKey(videoPath: string, timestamp_ms: number): string {
  return `${videoPath}:${timestamp_ms}`;
}

function pruneCache() {
  if (frameCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(frameCache.entries());
    const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE + 50);
    toRemove.forEach(([key]) => frameCache.delete(key));
  }
}

export function TimelineTrack({
  videoPath,
  duration,
  inPoint,
  outPoint,
  playhead,
  zoom,
  scrollOffset,
  waveform,
  thumbnailsEnabled = true,
  onInPointChange,
  onOutPointChange,
  onPlayheadChange,
  onScrollChange,
  onZoomChange,
}: TimelineTrackProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frames, setFrames] = useState<FilmstripFrame[]>([]);
  const [loadedImages, setLoadedImages] = useState<Map<number, HTMLImageElement>>(new Map());
  const [dragMode, setDragMode] = useState<'in' | 'out' | 'playhead' | null>(null);
  const [thumbnailsDisabled, setThumbnailsDisabled] = useState(false);

  // Refs for debouncing and request cancellation
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastRequestRef = useRef<string>('');

  const visibleDuration = duration / zoom;
  const startMs = scrollOffset * duration;
  const endMs = startMs + visibleDuration;

  // Memoize request params to avoid unnecessary fetches
  const requestKey = useMemo(() => {
    const roundedStart = Math.floor(startMs / 500) * 500;
    const roundedEnd = Math.ceil(endMs / 500) * 500;
    return `${videoPath}:${roundedStart}:${roundedEnd}:${zoom > 10 ? 'hi' : zoom > 3 ? 'med' : 'lo'}`;
  }, [videoPath, startMs, endMs, zoom]);

  // Check if thumbnails are disabled on mount
  useEffect(() => {
    getCacheStatus()
      .then((status) => setThumbnailsDisabled(status.thumbnails_disabled))
      .catch(() => {});
  }, []);

  // Load filmstrip frames with debouncing and cancellation
  useEffect(() => {
    // Skip if thumbnails disabled or not enabled via prop
    if (!thumbnailsEnabled || thumbnailsDisabled) {
      setFrames([]);
      return;
    }
    
    if (!videoPath || duration <= 0) return;

    // Skip if same request
    if (requestKey === lastRequestRef.current) return;

    // Clear previous debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    // Debounce: wait 150ms before fetching (shorter for better responsiveness)
    debounceRef.current = setTimeout(() => {
      // Cancel previous request
      if (abortRef.current) {
        abortRef.current.abort();
      }
      abortRef.current = new AbortController();

      lastRequestRef.current = requestKey;

      // Fewer frames = faster response. Scale with zoom level.
      const numFrames = zoom > 10 ? 15 : zoom > 3 ? 12 : 8;

      getFilmstripSegment(videoPath, Math.floor(startMs), Math.floor(endMs), numFrames)
        .then((newFrames) => {
          setFrames(newFrames);

          // Pre-load images and cache them
          const newImages = new Map<number, HTMLImageElement>();
          newFrames.forEach((frame) => {
            const cacheKey = getCacheKey(videoPath, frame.timestamp_ms);
            const cached = frameCache.get(cacheKey);

            if (cached?.image) {
              newImages.set(frame.timestamp_ms, cached.image);
            } else {
              const img = new Image();
              img.src = `data:image/jpeg;base64,${frame.image_base64}`;
              img.onload = () => {
                frameCache.set(cacheKey, { timestamp_ms: frame.timestamp_ms, image: img, loading: false });
                setLoadedImages((prev) => new Map(prev).set(frame.timestamp_ms, img));
              };
              frameCache.set(cacheKey, { timestamp_ms: frame.timestamp_ms, image: null, loading: true });
            }
          });

          setLoadedImages(newImages);
          pruneCache();
        })
        .catch(() => {
          // Only clear if not aborted
          if (abortRef.current?.signal.aborted) return;
          setFrames([]);
        });
    }, 150);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [videoPath, duration, startMs, endMs, zoom, requestKey, thumbnailsEnabled, thumbnailsDisabled]);

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const filmstripHeight = height * 0.6;
    const waveformHeight = height * 0.4;

    // Clear
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // Draw filmstrip frames using cached/pre-loaded images (synchronous, no flicker)
    if (frames.length > 0) {
      const frameWidth = width / frames.length;
      frames.forEach((frame, i) => {
        const cachedImg = loadedImages.get(frame.timestamp_ms);
        if (cachedImg && cachedImg.complete) {
          const x = i * frameWidth;
          ctx.drawImage(cachedImg, x, 0, frameWidth, filmstripHeight);
        } else {
          // Placeholder while loading
          const x = i * frameWidth;
          ctx.fillStyle = '#2a2a2a';
          ctx.fillRect(x, 0, frameWidth, filmstripHeight);
        }
      });
    }

    // Draw waveform
    if (waveform && waveform.amplitudes.length > 0) {
      const amplitudes = waveform.amplitudes;
      const samplesPerMs = waveform.samples_per_second / 1000;
      const startSample = Math.floor(startMs * samplesPerMs);
      const endSample = Math.ceil(endMs * samplesPerMs);
      const visibleAmplitudes = amplitudes.slice(
        Math.max(0, startSample),
        Math.min(amplitudes.length, endSample),
      );

      if (visibleAmplitudes.length > 0) {
        ctx.fillStyle = '#f59e0b';
        const barWidth = width / visibleAmplitudes.length;
        visibleAmplitudes.forEach((amp, i) => {
          const barHeight = amp * waveformHeight * 0.8;
          const x = i * barWidth;
          const y = filmstripHeight + (waveformHeight - barHeight) / 2;
          ctx.fillRect(x, y, Math.max(1, barWidth - 1), barHeight);
        });
      }
    }

    // Draw dimmed regions (before in, after out)
    const inPct = (inPoint - startMs) / visibleDuration;
    const outPct = (outPoint - startMs) / visibleDuration;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    if (inPct > 0) {
      ctx.fillRect(0, 0, inPct * width, height);
    }
    if (outPct < 1) {
      ctx.fillRect(outPct * width, 0, (1 - outPct) * width, height);
    }

    // Draw selection border
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      Math.max(0, inPct * width),
      0,
      Math.min(width, (outPct - inPct) * width),
      height,
    );

    // Draw in/out handles
    const handleWidth = 8;

    // In handle
    if (inPct >= 0 && inPct <= 1) {
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(inPct * width - handleWidth / 2, 0, handleWidth, height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(inPct * width - 1, 0, 2, height);
    }

    // Out handle
    if (outPct >= 0 && outPct <= 1) {
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(outPct * width - handleWidth / 2, 0, handleWidth, height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(outPct * width - 1, 0, 2, height);
    }

    // Draw playhead
    const playheadPct = (playhead - startMs) / visibleDuration;
    if (playheadPct >= 0 && playheadPct <= 1) {
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(playheadPct * width - 1, 0, 2, height);
      // Triangle head
      ctx.beginPath();
      ctx.moveTo(playheadPct * width - 6, 0);
      ctx.lineTo(playheadPct * width + 6, 0);
      ctx.lineTo(playheadPct * width, 10);
      ctx.closePath();
      ctx.fill();
    }
  }, [frames, loadedImages, waveform, inPoint, outPoint, playhead, startMs, visibleDuration, duration]);

  const getMsFromX = useCallback(
    (clientX: number): number => {
      if (!trackRef.current) return 0;
      const rect = trackRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const pct = Math.max(0, Math.min(1, x / rect.width));
      return startMs + pct * visibleDuration;
    },
    [startMs, visibleDuration],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!trackRef.current) return;

      const rect = trackRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = x / rect.width;
      const ms = startMs + pct * visibleDuration;

      const inPct = (inPoint - startMs) / visibleDuration;
      const outPct = (outPoint - startMs) / visibleDuration;
      const tolerance = 15 / rect.width;

      if (Math.abs(pct - inPct) < tolerance) {
        setDragMode('in');
        e.currentTarget.setPointerCapture(e.pointerId);
      } else if (Math.abs(pct - outPct) < tolerance) {
        setDragMode('out');
        e.currentTarget.setPointerCapture(e.pointerId);
      } else {
        setDragMode('playhead');
        onPlayheadChange(Math.max(0, Math.min(duration, ms)));
        e.currentTarget.setPointerCapture(e.pointerId);
      }
    },
    [startMs, visibleDuration, inPoint, outPoint, duration, onPlayheadChange],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragMode) return;

      const ms = getMsFromX(e.clientX);

      if (dragMode === 'in') {
        onInPointChange(Math.max(0, Math.min(outPoint - 100, ms)));
      } else if (dragMode === 'out') {
        onOutPointChange(Math.max(inPoint + 100, Math.min(duration, ms)));
      } else if (dragMode === 'playhead') {
        onPlayheadChange(Math.max(0, Math.min(duration, ms)));
      }
    },
    [dragMode, getMsFromX, inPoint, outPoint, duration, onInPointChange, onOutPointChange, onPlayheadChange],
  );

  const handlePointerUp = useCallback(() => {
    setDragMode(null);
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.8 : 1.25;
        const newZoom = Math.max(1, Math.min(50, zoom * delta));
        
        // Zoom toward mouse position
        const rect = trackRef.current?.getBoundingClientRect();
        if (rect) {
          const mousePct = (e.clientX - rect.left) / rect.width;
          const mouseMs = startMs + mousePct * visibleDuration;
          const newVisibleDuration = duration / newZoom;
          const newStartMs = mouseMs - mousePct * newVisibleDuration;
          onScrollChange(Math.max(0, Math.min(1 - newVisibleDuration / duration, newStartMs / duration)));
        }
        
        onZoomChange(newZoom);
      } else {
        // Horizontal scroll
        const scrollDelta = (e.deltaX || e.deltaY) * 0.001;
        const maxScroll = 1 - visibleDuration / duration;
        onScrollChange(Math.max(0, Math.min(maxScroll, scrollOffset + scrollDelta)));
      }
    },
    [zoom, duration, startMs, visibleDuration, scrollOffset, onZoomChange, onScrollChange],
  );

  return (
    <div
      ref={trackRef}
      className="h-[120px] bg-srve-bg relative cursor-crosshair"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ display: 'block' }}
      />
    </div>
  );
}
