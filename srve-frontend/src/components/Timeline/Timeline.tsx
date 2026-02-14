import { useCallback, useMemo, useRef, useState, type PointerEvent } from 'react';

import { useProjectStore } from '../../stores/projectStore';
import type { Layer, MidiNote } from '../../types';

const TRACK_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

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

function noteLengthToMs(mode: Layer['note_length_mode'], bpm: number): number {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const beatMs = 60000 / safeBpm;
  if (mode === '4th') return Math.trunc(beatMs);
  if (mode === '8th') return Math.trunc(beatMs / 2);
  if (mode === '16th') return Math.trunc(beatMs / 4);
  if (mode === '32nd') return Math.trunc(beatMs / 8);
  return 0;
}

type ClipBlock = {
  start_ms: number;
  duration_ms: number;
  velocity: number;
  clip_index: number;
};

export function Timeline() {
  const project = useProjectStore((s) => s.project);
  const midiData = useProjectStore((s) => s.midiData);
  const playheadMs = useProjectStore((s) => s.playheadMs);
  const setPlayhead = useProjectStore((s) => s.setPlayhead);
  const setScrubbing = useProjectStore((s) => s.setScrubbing);
  const previewFrame = useProjectStore((s) => s.previewFrame);

  const previewQuality = useProjectStore((s) => s.previewQuality);
  const setPreviewQuality = useProjectStore((s) => s.setPreviewQuality);
  const playbackState = useProjectStore((s) => s.playbackState);
  const bgm = useProjectStore((s) => s.bgm);

  const [collapsed, setCollapsed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);

  const bpm = project?.bpm ?? midiData?.bpm ?? 120;

  const enabledLayers = useMemo(() => {
    return (project?.layers ?? []).filter((l) => l.enabled).slice().sort((a, b) => a.order - b.order);
  }, [project?.layers]);

  const blocksByLayer = useMemo(() => {
    const out = new Map<string, ClipBlock[]>();
    if (!midiData) return out;

    for (const layer of enabledLayers) {
      const notes = midiData.channels[layer.midi_channel] ?? [];
      const blocks: ClipBlock[] = [];
      const forced = noteLengthToMs(layer.note_length_mode, bpm);
      notes.forEach((note: MidiNote, index: number) => {
        const duration = layer.note_length_mode === 'midi' ? note.duration_ms : forced;
        blocks.push({
          start_ms: note.start_ms,
          duration_ms: duration > 0 ? duration : 100,
          velocity: note.velocity,
          clip_index: index,
        });
      });
      out.set(layer.id, blocks);
    }

    return out;
  }, [bpm, enabledLayers, midiData]);

  const durationMs = useMemo(() => {
    const midiDur = midiData?.duration_ms ?? 0;
    const bgmDur = bgm?.duration_ms ?? 0;
    return Math.max(1000, midiDur, bgmDur);
  }, [bgm?.duration_ms, midiData?.duration_ms]);

  const pxPerMs = 0.05 * zoom;
  const timelineWidth = Math.max(600, Math.floor(durationMs * pxPerMs));

  const activeByLayer = useMemo(() => {
    const map = new Map<string, number>();
    const active = previewFrame?.active_layers ?? [];
    for (const a of active) {
      map.set(a.layer_id, a.clip_index);
    }
    return map;
  }, [previewFrame?.active_layers]);

  const setPlayheadFromClientX = useCallback(
    (clientX: number) => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const x = clientX - rect.left + scroller.scrollLeft;
      const ms = Math.trunc(x / pxPerMs);
      setPlayhead(Math.max(0, Math.min(durationMs, ms)));
    },
    [durationMs, pxPerMs, setPlayhead],
  );

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    scrubbingRef.current = true;
    setScrubbing(true);
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    setPlayheadFromClientX(e.clientX);
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    setPlayheadFromClientX(e.clientX);
  };

  const handlePointerUp = () => {
    scrubbingRef.current = false;
    setScrubbing(false);
  };

  const allStarts = useMemo(() => {
    const starts: number[] = [];
    for (const layer of enabledLayers) {
      const blocks = blocksByLayer.get(layer.id) ?? [];
      blocks.forEach((b) => starts.push(b.start_ms));
    }
    starts.sort((a, b) => a - b);
    return starts;
  }, [blocksByLayer, enabledLayers]);

  const stepToPrev = () => {
    for (let i = allStarts.length - 1; i >= 0; i -= 1) {
      const t = allStarts[i];
      if (t < playheadMs) {
        setPlayhead(t);
        return;
      }
    }
    setPlayhead(0);
  };

  const stepToNext = () => {
    for (let i = 0; i < allStarts.length; i += 1) {
      const t = allStarts[i];
      if (t > playheadMs) {
        setPlayhead(t);
        return;
      }
    }
  };

  return (
    <div className="h-full p-3 flex flex-col">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-white">MIDI Timeline Preview</div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="text-xs px-2 py-1 rounded bg-white/5 border border-white/10 hover:bg-white/10"
        >
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </div>

      {collapsed ? null : (
        <div className="mt-3 flex-1 min-h-0 flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-gray-400">
            <div className="flex items-center gap-3">
              <div className="text-gray-300">Zoom</div>
              <input
                type="range"
                min={0.5}
                max={5}
                step={0.1}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
              />
            </div>
            <div className="font-mono">Playhead: {formatMs(playheadMs)}</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={stepToPrev}
                className="px-2 py-1 rounded bg-white/5 border border-white/10 hover:bg-white/10"
              >
                ◀
              </button>
              <button
                type="button"
                onClick={stepToNext}
                className="px-2 py-1 rounded bg-white/5 border border-white/10 hover:bg-white/10"
              >
                ▶
              </button>
              <select
                value={previewQuality}
                onChange={(e) => setPreviewQuality(e.target.value as 'fast' | 'high')}
                className="px-2 py-1 rounded bg-white/5 border border-white/10 text-gray-300 text-xs"
              >
                <option value="fast">Fast (960p)</option>
                <option value="high">High (1280p)</option>
              </select>
              <div className="text-xs text-gray-500 ml-2">
                {playbackState === 'rendering' ? '⏳ Buffering...' : playbackState === 'playing' ? '▶ Playing' : 'Space to play'}
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 rounded bg-srve-bg border border-white/10 overflow-hidden">
            <div className="h-full flex">
              <div className="w-[180px] shrink-0 border-r border-white/10">
                <div className="h-7 px-2 flex items-center text-[11px] text-gray-400 border-b border-white/10">
                  Ruler
                </div>
                {enabledLayers.map((layer) => (
                  <div
                    key={layer.id}
                    className="h-7 px-2 flex items-center text-[11px] text-gray-300 border-b border-white/10 truncate"
                    title={`${layer.name} (CH ${layer.midi_channel})`}
                  >
                    {layer.name} (CH {layer.midi_channel})
                  </div>
                ))}
                <div className="h-7 px-2 flex items-center text-[11px] text-gray-400">BGM Waveform</div>
              </div>

              <div className="flex-1 min-w-0">
                <div
                  ref={scrollRef}
                  className="h-full overflow-x-auto overflow-y-hidden"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                >
                  <div className="relative" style={{ width: timelineWidth }}>
                    <div className="h-7 border-b border-white/10 relative">
                      {Array.from({ length: Math.ceil(durationMs / 5000) + 1 }, (_, i) => i).map((i) => {
                        const t = i * 5000;
                        const x = t * pxPerMs;
                        return (
                          <div key={t} className="absolute top-0 bottom-0" style={{ left: x }}>
                            <div className="w-px h-full bg-white/10" />
                            <div className="absolute top-0 left-1 -translate-y-0.5 text-[10px] text-gray-400">
                              {Math.floor(t / 1000)}s
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {enabledLayers.map((layer, layerIndex) => {
                      const blocks = blocksByLayer.get(layer.id) ?? [];
                      const color = TRACK_COLORS[layerIndex % TRACK_COLORS.length];
                      const activeClipIndex = activeByLayer.get(layer.id);
                      return (
                        <div key={layer.id} className="h-7 border-b border-white/10 relative">
                          {blocks.map((b) => {
                            const left = b.start_ms * pxPerMs;
                            const width = Math.max(2, b.duration_ms * pxPerMs);
                            const isActive = activeClipIndex === b.clip_index;
                            const opacity = layer.velocity_opacity ? Math.max(0.15, b.velocity / 127) : 0.9;
                            return (
                              <div
                                key={b.clip_index}
                                className={
                                  isActive
                                    ? 'absolute top-1 bottom-1 rounded border'
                                    : 'absolute top-1 bottom-1 rounded'
                                }
                                style={{
                                  left,
                                  width,
                                  backgroundColor: color,
                                  opacity,
                                  borderColor: isActive ? '#ffffff' : undefined,
                                }}
                                title={`Clip ${b.clip_index} | ${formatMs(b.start_ms)} - ${formatMs(
                                  b.start_ms + b.duration_ms,
                                )} | Vel ${b.velocity}`}
                              />
                            );
                          })}
                        </div>
                      );
                    })}

                    <div className="h-7 relative">
                      <div className="absolute inset-0 flex items-center">
                        <div className="w-full h-px bg-white/10" />
                      </div>
                    </div>

                    <div
                      className="absolute top-0 bottom-0 w-px bg-srve-accent"
                      style={{ left: playheadMs * pxPerMs }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
