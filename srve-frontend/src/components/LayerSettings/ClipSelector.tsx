import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getVideoFilmstrip } from '../../api/client';
import type { SourceVideo } from '../../types';

type DragMode = 'in' | 'out' | 'playhead' | null;

type EditingField = 'in' | 'out' | null;

type FilmstripCacheEntry = {
  frames: string[];
};

const filmstripCache = new Map<string, FilmstripCacheEntry>();

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function formatMs(ms: number): string {
  const safe = Math.max(0, Math.trunc(ms));
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = safe % 1000;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${millis
    .toString()
    .padStart(3, '0')}`;
}

function parseTimecode(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;

  const parts = raw
    .split(':')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length === 2) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
    return Math.trunc((minutes * 60 + seconds) * 1000);
  }

  if (parts.length === 3) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    const millis = Number(parts[2]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || !Number.isFinite(millis)) return null;
    return Math.trunc((minutes * 60 + seconds) * 1000 + millis);
  }

  if (parts.length === 4) {
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2]);
    const millis = Number(parts[3]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds) || !Number.isFinite(millis)) return null;
    return Math.trunc((hours * 3600 + minutes * 60 + seconds) * 1000 + millis);
  }

  return null;
}

function buildFrameSrc(base64: string): string {
  return `data:image/jpeg;base64,${base64}`;
}

export type ClipSelectorProps = {
  sourceVideo: SourceVideo;
  inPoint: number;
  outPoint: number;
  onInPointChange: (ms: number) => void;
  onOutPointChange: (ms: number) => void;
  numFrames?: number;
};

export function ClipSelector({
  sourceVideo,
  inPoint,
  outPoint,
  onInPointChange,
  onOutPointChange,
  numFrames = 20,
}: ClipSelectorProps) {
  const durationMs = Math.max(0, Math.trunc(sourceVideo.duration_ms || 0));
  const safeNumFrames = Math.max(1, Math.min(200, Math.trunc(numFrames)));

  const [frames, setFrames] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filmstripRef = useRef<HTMLDivElement | null>(null);
  const dragModeRef = useRef<DragMode>(null);

  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [dragInMs, setDragInMs] = useState<number | null>(null);
  const [dragOutMs, setDragOutMs] = useState<number | null>(null);

  const [activeHandle, setActiveHandle] = useState<'in' | 'out' | null>(null);

  const [playheadMs, setPlayheadMs] = useState(0);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  const [editingField, setEditingField] = useState<EditingField>(null);
  const [editingDraft, setEditingDraft] = useState('');

  const commitRafRef = useRef<number | null>(null);
  const pendingCommitRef = useRef<{ kind: 'in' | 'out'; value: number } | null>(null);

  const boundsRef = useRef<{ inMs: number; outMs: number }>({ inMs: 0, outMs: 0 });

  const displayIn = useMemo(() => {
    const base = dragInMs ?? inPoint;
    return Math.trunc(clampNumber(base, 0, durationMs));
  }, [dragInMs, durationMs, inPoint]);

  const displayOut = useMemo(() => {
    const base = dragOutMs ?? outPoint;
    return Math.trunc(clampNumber(base, 0, durationMs));
  }, [dragOutMs, durationMs, outPoint]);

  const normalized = useMemo(() => {
    const i = Math.trunc(clampNumber(displayIn, 0, durationMs));
    const o = Math.trunc(clampNumber(displayOut, 0, durationMs));
    return {
      inMs: Math.min(i, o),
      outMs: Math.max(i, o),
    };
  }, [displayIn, displayOut, durationMs]);

  useEffect(() => {
    boundsRef.current = { inMs: normalized.inMs, outMs: normalized.outMs };
  }, [normalized.inMs, normalized.outMs]);

  useEffect(() => {
    if (!durationMs) {
      setPlayheadMs(0);
      return;
    }
    setPlayheadMs((prev) => Math.trunc(clampNumber(prev, 0, durationMs)));
  }, [durationMs]);

  useEffect(() => {
    if (!durationMs) {
      setPlayheadMs(0);
      return;
    }
    setPlayheadMs((prev) => {
      if (prev === 0 && normalized.inMs > 0) return normalized.inMs;
      return Math.trunc(clampNumber(prev, 0, durationMs));
    });
  }, [durationMs, normalized.inMs]);

  useEffect(() => {
    let cancelled = false;
    const key = `${sourceVideo.path}|${safeNumFrames}`;

    const cached = filmstripCache.get(key);
    if (cached?.frames?.length) {
      setFrames(cached.frames);
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    setFrames([]);

    async function load() {
      try {
        const res = await getVideoFilmstrip(sourceVideo.path, safeNumFrames);
        if (cancelled) return;
        const urls = res.map((b64) => buildFrameSrc(b64));
        filmstripCache.set(key, { frames: urls });
        setFrames(urls);
      } catch (err: unknown) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [safeNumFrames, sourceVideo.path]);

  function pctFromMs(ms: number): number {
    if (!durationMs) return 0;
    return clampNumber(ms / durationMs, 0, 1);
  }

  const inPct = pctFromMs(normalized.inMs);
  const outPct = pctFromMs(normalized.outMs);

  const effectivePlayhead = Math.trunc(clampNumber(playheadMs, 0, durationMs));
  const playheadPct = pctFromMs(effectivePlayhead);

  const previewMs = useMemo(() => {
    if (dragMode === 'in') return normalized.inMs;
    if (dragMode === 'out') return normalized.outMs;
    if (dragMode === 'playhead') return effectivePlayhead;
    if (hoverMs != null) return Math.trunc(clampNumber(hoverMs, 0, durationMs));
    return effectivePlayhead;
  }, [dragMode, durationMs, effectivePlayhead, hoverMs, normalized.inMs, normalized.outMs]);

  const previewSrc = useMemo(() => {
    if (!frames.length || !durationMs) return null;
    if (frames.length === 1) return frames[0] ?? null;

    const idx = Math.trunc(clampNumber(Math.round((previewMs / durationMs) * (frames.length - 1)), 0, frames.length - 1));
    return frames[idx] ?? null;
  }, [durationMs, frames, previewMs]);

  const scheduleCommit = useCallback(
    (kind: 'in' | 'out', value: number) => {
      pendingCommitRef.current = { kind, value };

      if (commitRafRef.current != null) return;
      commitRafRef.current = window.requestAnimationFrame(() => {
        commitRafRef.current = null;
        const pending = pendingCommitRef.current;
        if (!pending) return;

        if (pending.kind === 'in') {
          onInPointChange(pending.value);
        } else {
          onOutPointChange(pending.value);
        }
      });
    },
    [onInPointChange, onOutPointChange],
  );

  useEffect(() => {
    return () => {
      if (commitRafRef.current != null) {
        window.cancelAnimationFrame(commitRafRef.current);
        commitRafRef.current = null;
      }
    };
  }, []);

  const msFromClientX = useCallback(
    (clientX: number): number => {
      if (!filmstripRef.current || !durationMs) return 0;
      const rect = filmstripRef.current.getBoundingClientRect();
      const x = clampNumber(clientX - rect.left, 0, rect.width);
      const pct = rect.width ? x / rect.width : 0;
      return Math.trunc(clampNumber(Math.round(pct * durationMs), 0, durationMs));
    },
    [durationMs],
  );

  function beginDrag(mode: DragMode, clientX: number) {
    dragModeRef.current = mode;
    setDragMode(mode);

    if (mode === 'in') {
      setActiveHandle('in');
      setDragInMs(normalized.inMs);
      const next = Math.min(msFromClientX(clientX), normalized.outMs);
      setDragInMs(next);
      scheduleCommit('in', next);
      return;
    }

    if (mode === 'out') {
      setActiveHandle('out');
      setDragOutMs(normalized.outMs);
      const next = Math.max(msFromClientX(clientX), normalized.inMs);
      setDragOutMs(next);
      scheduleCommit('out', next);
      return;
    }

    if (mode === 'playhead') {
      const next = msFromClientX(clientX);
      setPlayheadMs(next);
    }
  }

  useEffect(() => {
    if (!dragMode) return;

    const onMove = (event: PointerEvent) => {
      const mode = dragModeRef.current;
      if (!mode) return;

      const bounds = boundsRef.current;

      if (mode === 'in') {
        const next = Math.min(msFromClientX(event.clientX), bounds.outMs);
        setDragInMs(next);
        scheduleCommit('in', next);
        return;
      }

      if (mode === 'out') {
        const next = Math.max(msFromClientX(event.clientX), bounds.inMs);
        setDragOutMs(next);
        scheduleCommit('out', next);
        return;
      }

      if (mode === 'playhead') {
        const next = msFromClientX(event.clientX);
        setPlayheadMs(next);
      }
    };

    const onUp = () => {
      dragModeRef.current = null;
      setDragMode(null);
      setDragInMs(null);
      setDragOutMs(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragMode, msFromClientX, scheduleCommit]);

  function startEdit(field: EditingField) {
    setEditingField(field);
    if (field === 'in') {
      setEditingDraft(formatMs(normalized.inMs));
    } else if (field === 'out') {
      setEditingDraft(formatMs(normalized.outMs));
    }
  }

  function commitEdit() {
    const field = editingField;
    setEditingField(null);

    const parsed = parseTimecode(editingDraft);
    if (parsed == null) return;

    if (field === 'in') {
      const next = Math.trunc(clampNumber(parsed, 0, normalized.outMs));
      onInPointChange(next);
      setPlayheadMs((prev) => (prev < next ? next : prev));
      return;
    }

    if (field === 'out') {
      const next = Math.trunc(clampNumber(parsed, normalized.inMs, durationMs));
      onOutPointChange(next);
      setPlayheadMs((prev) => (prev > next ? next : prev));
    }
  }

  function cancelEdit() {
    setEditingField(null);
  }

  const selectionDuration = Math.max(0, normalized.outMs - normalized.inMs);
  const stepMs = useMemo(() => {
    if (!durationMs) return 1;
    if (safeNumFrames <= 1) return Math.max(1, durationMs);
    return Math.max(1, Math.round(durationMs / (safeNumFrames - 1)));
  }, [durationMs, safeNumFrames]);

  return (
    <div className="w-full">
      <div className="flex items-start justify-between gap-2">
        <div className="w-[160px] h-[90px] shrink-0 rounded bg-srve-bg border border-white/10 overflow-hidden flex items-center justify-center">
          {previewSrc ? (
            <img src={previewSrc} alt="Preview" className="w-full h-full object-cover" draggable={false} />
          ) : (
            <div className="text-[10px] text-gray-500">{error ? 'Error' : isLoading ? 'Loading' : '--'}</div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-gray-400">Current</div>
          <div className="text-xs text-gray-200">{formatMs(previewMs)}</div>
          {error ? <div className="mt-1 text-[11px] text-red-400 truncate">{error}</div> : null}
        </div>
      </div>

      <div
        ref={filmstripRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (!activeHandle) return;
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();

          const delta = e.key === 'ArrowLeft' ? -stepMs : stepMs;

          if (activeHandle === 'in') {
            const next = Math.trunc(clampNumber(normalized.inMs + delta, 0, normalized.outMs));
            onInPointChange(next);
            setPlayheadMs((prev) => (prev < next ? next : prev));
          } else {
            const next = Math.trunc(clampNumber(normalized.outMs + delta, normalized.inMs, durationMs));
            onOutPointChange(next);
            setPlayheadMs((prev) => (prev > next ? next : prev));
          }
        }}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement)?.dataset?.handle) return;
          beginDrag('playhead', e.clientX);
        }}
        onMouseMove={(e) => {
          if (dragMode) return;
          setHoverMs(msFromClientX(e.clientX));
        }}
        onMouseLeave={() => setHoverMs(null)}
        className="mt-2 relative w-full h-[60px] rounded bg-[#1a1a1a] border border-white/10 overflow-hidden select-none"
      >
        {isLoading ? (
          <div
            className="absolute inset-0 grid"
            style={{ gridTemplateColumns: `repeat(${safeNumFrames}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: safeNumFrames }, (_, i) => (
              <div key={i} className="h-full w-full bg-white/5" />
            ))}
          </div>
        ) : frames.length ? (
          <div
            className="absolute inset-0 grid"
            style={{ gridTemplateColumns: `repeat(${frames.length}, minmax(0, 1fr))` }}
          >
            {frames.map((src, idx) => (
              <div key={idx} className="h-full w-full overflow-hidden">
                <img src={src} alt="" className="w-full h-full object-cover" draggable={false} />
              </div>
            ))}
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-[11px] text-gray-500">No filmstrip</div>
          </div>
        )}

        <div
          className="absolute inset-y-0 left-0"
          style={{ width: `${inPct * 100}%`, background: 'rgba(0,0,0,0.55)' }}
        />
        <div
          className="absolute inset-y-0"
          style={{ left: `${inPct * 100}%`, width: `${(outPct - inPct) * 100}%`, background: 'rgba(59,130,246,0.30)' }}
        />
        <div
          className="absolute inset-y-0"
          style={{ left: `${outPct * 100}%`, right: 0, background: 'rgba(0,0,0,0.55)' }}
        />

        <div
          className="absolute top-0 bottom-0"
          style={{ left: `calc(${playheadPct * 100}% - 0.5px)`, width: 1, background: 'rgba(255,255,255,0.75)' }}
        />

        <div
          data-handle="in"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            beginDrag('in', e.clientX);
          }}
          className="absolute top-0 bottom-0 cursor-ew-resize"
          style={{
            left: `calc(${inPct * 100}% - 4px)`,
            width: 8,
            background: '#3b82f6',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.35) inset',
            backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.22) 0, rgba(255,255,255,0.22) 1px, rgba(255,255,255,0) 1px, rgba(255,255,255,0) 3px)',
          }}
          title="Drag In"
        />

        <div
          data-handle="out"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            beginDrag('out', e.clientX);
          }}
          className="absolute top-0 bottom-0 cursor-ew-resize"
          style={{
            left: `calc(${outPct * 100}% - 4px)`,
            width: 8,
            background: '#3b82f6',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.35) inset',
            backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.22) 0, rgba(255,255,255,0.22) 1px, rgba(255,255,255,0) 1px, rgba(255,255,255,0) 3px)',
          }}
          title="Drag Out"
        />
      </div>

      <div className="mt-2 rounded bg-white/5 border border-white/10 px-3 py-2">
        <div className="flex items-center justify-between gap-2 text-[11px] text-gray-200">
          <div className="flex items-center gap-1 min-w-0">
            <span className="text-gray-400">In:</span>
            {editingField === 'in' ? (
              <input
                autoFocus
                value={editingDraft}
                onChange={(e) => setEditingDraft(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
                className="w-[92px] rounded bg-srve-bg border border-white/10 px-2 py-1 text-[11px] text-gray-200"
              />
            ) : (
              <button
                type="button"
                onClick={() => startEdit('in')}
                className="px-2 py-1 rounded bg-srve-bg border border-white/10 hover:bg-white/10"
              >
                {formatMs(normalized.inMs)}
              </button>
            )}
          </div>

          <div className="flex items-center gap-1 min-w-0">
            <span className="text-gray-400">Out:</span>
            {editingField === 'out' ? (
              <input
                autoFocus
                value={editingDraft}
                onChange={(e) => setEditingDraft(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
                className="w-[92px] rounded bg-srve-bg border border-white/10 px-2 py-1 text-[11px] text-gray-200"
              />
            ) : (
              <button
                type="button"
                onClick={() => startEdit('out')}
                className="px-2 py-1 rounded bg-srve-bg border border-white/10 hover:bg-white/10"
              >
                {formatMs(normalized.outMs)}
              </button>
            )}
          </div>

          <div className="flex items-center gap-1">
            <span className="text-gray-400">Duration:</span>
            <span className="px-2 py-1 rounded bg-srve-bg border border-white/10">{formatMs(selectionDuration)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
