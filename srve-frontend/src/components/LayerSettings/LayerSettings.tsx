import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getVideoThumbnail } from '../../api/client';
import { useProjectStore } from '../../stores/projectStore';
import { EasingType, FlipMode, type Layer, type SourceVideo } from '../../types';
import type { TrimmerResult } from '../../vite-env';

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clampGridPosition(position: [number, number], grid: [number, number]): [number, number] {
  const cols = Math.max(1, Math.trunc(grid[0] ?? 1));
  const rows = Math.max(1, Math.trunc(grid[1] ?? 1));
  const col = clampNumber(position[0] ?? 0, 0, cols - 1);
  const row = clampNumber(position[1] ?? 0, 0, rows - 1);
  return [col, row];
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

function FlipIcon({ mode }: { mode: FlipMode }) {
  const base = 'w-6 h-6 text-gray-300';
  if (mode === FlipMode.NONE) {
    return (
      <svg viewBox="0 0 24 24" className={base} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
      </svg>
    );
  }
  if (mode === FlipMode.ALTERNATING) {
    return (
      <svg viewBox="0 0 24 24" className={base} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M7 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M7 12h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M7 16h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (mode === FlipMode.ROTATION_CW) {
    return (
      <svg viewBox="0 0 24 24" className={base} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path
          d="M12 6a6 6 0 1 1-5.6 3.8"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path d="M6 6v5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={base} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M12 6a6 6 0 1 0 5.6 3.8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M18 6v5h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LayerSettings() {
  const project = useProjectStore((s) => s.project);
  const selectedLayerId = useProjectStore((s) => s.selectedLayerId);
  const updateLayer = useProjectStore((s) => s.updateLayer);

  const layers = project?.layers ?? [];
  const videos = project?.source_videos ?? [];
  const globalGrid = project?.settings.global_grid ?? [3, 3];
  const snapToGrid = project?.settings.snap_to_grid ?? true;
  const snapSubdivisions = Math.max(1, Math.trunc(project?.settings.snap_subdivisions ?? 1));

  const layer = useMemo(() => {
    if (!selectedLayerId) return null;
    return layers.find((l) => l.id === selectedLayerId) ?? null;
  }, [layers, selectedLayerId]);

  const videoById = useMemo(() => {
    const map = new Map<string, SourceVideo>();
    for (const v of videos) map.set(v.id, v);
    return map;
  }, [videos]);

  const selectedVideo = layer?.source_video_id ? videoById.get(layer.source_video_id) ?? null : null;
  const durationMs = selectedVideo?.duration_ms ?? 0;

  const resolvedOutMs = useMemo(() => {
    if (!layer) return 0;
    const out = layer.clip_settings.out_point_ms;
    if (out < 0) return durationMs;
    return clampNumber(out, 0, durationMs);
  }, [durationMs, layer]);

  const resolvedInMs = useMemo(() => {
    if (!layer) return 0;
    return clampNumber(layer.clip_settings.in_point_ms, 0, durationMs);
  }, [durationMs, layer]);

  const thumbsRef = useRef<Record<string, string>>({});
  const [thumb, setThumb] = useState<string | null>(null);
  const loadingThumbIds = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    setThumb(null);

    async function load(video: SourceVideo) {
      const cached = thumbsRef.current[video.id];
      if (cached) {
        setThumb(cached);
        return;
      }
      if (loadingThumbIds.current.has(video.id)) return;

      loadingThumbIds.current.add(video.id);
      try {
        const res = await getVideoThumbnail(video.path, 0);
        const dataUrl = `data:image/jpeg;base64,${res.image_base64}`;
        thumbsRef.current = { ...thumbsRef.current, [video.id]: dataUrl };
        if (!cancelled) setThumb(dataUrl);
      } finally {
        loadingThumbIds.current.delete(video.id);
      }
    }

    if (selectedVideo) {
      void load(selectedVideo);
    }

    return () => {
      cancelled = true;
    };
  }, [selectedVideo?.id, selectedVideo?.path]);

  const activeGrid = useMemo(() => {
    if (!layer) return globalGrid;
    return layer.use_global_grid ? globalGrid : layer.custom_grid ?? globalGrid;
  }, [globalGrid, layer]);

  const gridCols = Math.max(1, Math.trunc(activeGrid[0] ?? 1));
  const gridRows = Math.max(1, Math.trunc(activeGrid[1] ?? 1));

  const gridCol = clampNumber(layer?.grid_position[0] ?? 0, 0, gridCols - 1);
  const gridRow = clampNumber(layer?.grid_position[1] ?? 0, 0, gridRows - 1);

  const gridStep = snapToGrid ? 1 / snapSubdivisions : 1;

  function snapValue(value: number): number {
    if (!snapToGrid) return value;
    const sub = Math.max(1, snapSubdivisions);
    return Math.round(value * sub) / sub;
  }

  function setClipSettings(next: Partial<Layer['clip_settings']>) {
    if (!layer) return;
    updateLayer(layer.id, {
      clip_settings: {
        ...layer.clip_settings,
        ...next,
      },
    });
  }

  function setEffects(next: Partial<Layer['effects']>) {
    if (!layer) return;
    updateLayer(layer.id, {
      effects: {
        ...layer.effects,
        ...next,
      },
    });
  }

  const handleOpenTrimmer = useCallback(() => {
    if (!layer || !selectedVideo) return;
    window.srve?.openTrimmer?.({
      videoPath: selectedVideo.path,
      videoName: selectedVideo.name,
      videoDuration: durationMs,
      videoFps: selectedVideo.fps || 30,
      currentIn: resolvedInMs,
      currentOut: resolvedOutMs,
      layerId: layer.id,
    });
  }, [layer, selectedVideo, durationMs, resolvedInMs, resolvedOutMs]);

  useEffect(() => {
    const unsubscribe = window.srve?.onTrimmerResult?.((result: TrimmerResult) => {
      if (result.cancelled) return;
      if (result.layerId !== layer?.id) return;

      const nextIn = Math.trunc(clampNumber(result.inPoint, 0, durationMs));
      const nextOut = Math.trunc(clampNumber(result.outPoint, 0, durationMs));

      setClipSettings({
        in_point_ms: nextIn,
        out_point_ms: nextOut >= durationMs ? -1 : nextOut,
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [layer?.id, durationMs]);

  const nameValue = layer ? layer.name : '(no layer selected)';
  const isDisabled = !layer;

  return (
    <div className="h-full p-3 flex flex-col overflow-auto">
      <div className="text-sm font-semibold text-white">Layer Settings</div>

      <div className="mt-3 space-y-3">
        <div className="space-y-1">
          <div className="text-xs text-gray-400">Name</div>
          <input
            disabled
            value={nameValue}
            className="w-full rounded bg-srve-bg border border-white/10 px-3 py-2 text-sm text-gray-300 disabled:opacity-60"
          />
        </div>

        <div className="border-t border-white/10" />

        <div>
          <div className="text-xs font-semibold text-white">Source Video</div>

          <div className="mt-2 grid grid-cols-1 gap-2">
            <div className="space-y-1">
              <div className="text-[11px] text-gray-400">Source</div>
              <select
                disabled={isDisabled}
                value={layer?.source_video_id ?? ''}
                onChange={(e) => {
                  if (!layer) return;
                  const nextId = e.target.value || null;
                  updateLayer(layer.id, { source_video_id: nextId });
                }}
                className="w-full rounded bg-srve-bg border border-white/10 px-2 py-2 text-xs text-gray-200 disabled:opacity-60"
              >
                <option value="">None</option>
                {videos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <div className="w-[96px] h-[56px] shrink-0 rounded bg-srve-bg border border-white/10 overflow-hidden flex items-center justify-center">
                {selectedVideo && thumb ? (
                  <img src={thumb} alt={selectedVideo.name} className="w-full h-full object-cover" draggable={false} />
                ) : (
                  <div className="text-[10px] text-gray-500">--</div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-gray-400">Duration</div>
                <div className="text-xs text-gray-200">{selectedVideo ? formatMs(durationMs) : '--'}</div>
              </div>
            </div>

            {layer && selectedVideo ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-400">In:</span>
                  <span className="font-mono text-gray-200">{formatMs(resolvedInMs)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-400">Out:</span>
                  <span className="font-mono text-gray-200">{formatMs(resolvedOutMs)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-400">Selection:</span>
                  <span className="font-mono text-gray-200">{formatMs(resolvedOutMs - resolvedInMs)}</span>
                </div>
                <button
                  onClick={handleOpenTrimmer}
                  disabled={isDisabled}
                  className="w-full mt-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:cursor-not-allowed rounded text-xs font-medium text-white transition-colors flex items-center justify-center gap-2"
                >
                  <span>✂️</span>
                  <span>Open Clip Trimmer</span>
                </button>
              </div>
            ) : (
              <div className="rounded bg-white/5 border border-white/10 px-3 py-2 text-xs text-gray-400">
                Assign a source video to trim.
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <div className="text-[11px] text-gray-400">Loop Mode</div>
                <select
                  disabled={isDisabled}
                  value={layer?.clip_settings.loop_mode ?? 'freeze'}
                  onChange={(e) => setClipSettings({ loop_mode: e.target.value as Layer['clip_settings']['loop_mode'] })}
                  className="w-full rounded bg-srve-bg border border-white/10 px-2 py-2 text-xs text-gray-200 disabled:opacity-60"
                >
                  <option value="crossfade">Crossfade</option>
                  <option value="freeze">Freeze Frame</option>
                  <option value="continue">Continue</option>
                </select>
              </div>

              {layer?.clip_settings.loop_mode === 'crossfade' ? (
                <div className="space-y-1">
                  <div className="text-[11px] text-gray-400">Crossfade %</div>
                  <input
                    type="range"
                    disabled={isDisabled}
                    min={1}
                    max={50}
                    step={1}
                    value={clampNumber(layer?.clip_settings.crossfade_percent ?? 10, 1, 50)}
                    onChange={(e) => setClipSettings({ crossfade_percent: clampNumber(Number(e.target.value), 1, 50) })}
                    className="w-full disabled:opacity-60"
                  />
                  <div className="text-[11px] text-gray-300">
                    {clampNumber(layer?.clip_settings.crossfade_percent ?? 10, 1, 50).toFixed(0)}%
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-[11px] text-gray-400">Crossfade %</div>
                  <input type="range" disabled min={1} max={50} value={10} className="w-full disabled:opacity-60" />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-white/10" />

        <div>
          <div className="text-xs font-semibold text-white">MIDI</div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <div className="text-[11px] text-gray-400">Channel</div>
              <select
                disabled={isDisabled}
                value={layer?.midi_channel ?? 1}
                onChange={(e) => {
                  if (!layer) return;
                  updateLayer(layer.id, { midi_channel: clampNumber(Number(e.target.value), 1, 16) });
                }}
                className="w-full rounded bg-srve-bg border border-white/10 px-2 py-2 text-xs text-gray-200 disabled:opacity-60"
              >
                {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
                  <option key={ch} value={ch}>
                    {ch}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <div className="text-[11px] text-gray-400">Note Length</div>
              <select
                disabled={isDisabled}
                value={layer?.note_length_mode ?? 'midi'}
                onChange={(e) => {
                  if (!layer) return;
                  updateLayer(layer.id, { note_length_mode: e.target.value as Layer['note_length_mode'] });
                }}
                className="w-full rounded bg-srve-bg border border-white/10 px-2 py-2 text-xs text-gray-200 disabled:opacity-60"
              >
                <option value="midi">Use MIDI Length</option>
                <option value="4th">Force 1/4</option>
                <option value="8th">Force 1/8</option>
                <option value="16th">Force 1/16</option>
                <option value="32nd">Force 1/32</option>
              </select>
            </div>
          </div>
        </div>

        <div className="border-t border-white/10" />

        <div>
          <div className="text-xs font-semibold text-white">Position</div>

          <div className="mt-2 space-y-2">
            <label className="flex items-center justify-between rounded bg-white/5 border border-white/10 px-3 py-2">
              <div className="text-xs text-gray-200">Use Global Grid</div>
              <input
                type="checkbox"
                disabled={isDisabled}
                checked={layer?.use_global_grid ?? true}
                onChange={(e) => {
                  if (!layer) return;
                  const checked = e.target.checked;
                  if (checked) {
                    const nextPos = clampGridPosition(layer.grid_position, globalGrid);
                    updateLayer(layer.id, { use_global_grid: true, custom_grid: null, grid_position: nextPos });
                  } else {
                    const fallback = layer.custom_grid ?? globalGrid;
                    const nextPos = clampGridPosition(layer.grid_position, fallback);
                    updateLayer(layer.id, { use_global_grid: false, custom_grid: fallback, grid_position: nextPos });
                  }
                }}
                className="accent-srve-accent disabled:opacity-60"
              />
            </label>

            {!layer?.use_global_grid ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <div className="text-[11px] text-gray-400">Columns</div>
                  <input
                    type="number"
                    disabled={isDisabled}
                    min={1}
                    max={64}
                    value={layer?.custom_grid?.[0] ?? globalGrid[0]}
                    onChange={(e) => {
                      if (!layer) return;
                      const nextCols = Math.max(1, Math.trunc(Number(e.target.value) || 1));
                      const nextRows = layer.custom_grid?.[1] ?? globalGrid[1];
                      const nextGrid: [number, number] = [nextCols, nextRows];
                      const nextPos = clampGridPosition(layer.grid_position, nextGrid);
                      updateLayer(layer.id, { custom_grid: nextGrid, grid_position: nextPos });
                    }}
                    className="w-full rounded bg-srve-bg border border-white/10 px-2 py-1 text-xs text-gray-200 disabled:opacity-60"
                  />
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] text-gray-400">Rows</div>
                  <input
                    type="number"
                    disabled={isDisabled}
                    min={1}
                    max={64}
                    value={layer?.custom_grid?.[1] ?? globalGrid[1]}
                    onChange={(e) => {
                      if (!layer) return;
                      const nextRows = Math.max(1, Math.trunc(Number(e.target.value) || 1));
                      const nextCols = layer.custom_grid?.[0] ?? globalGrid[0];
                      const nextGrid: [number, number] = [nextCols, nextRows];
                      const nextPos = clampGridPosition(layer.grid_position, nextGrid);
                      updateLayer(layer.id, { custom_grid: nextGrid, grid_position: nextPos });
                    }}
                    className="w-full rounded bg-srve-bg border border-white/10 px-2 py-1 text-xs text-gray-200 disabled:opacity-60"
                  />
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <div className="text-[11px] text-gray-400">Column</div>
                <input
                  type="number"
                  disabled={isDisabled}
                  min={0}
                  max={Math.max(0, gridCols - 1)}
                  step={gridStep}
                  value={snapValue(gridCol)}
                  onChange={(e) => {
                    if (!layer) return;
                    const raw = Number(e.target.value);
                    if (!Number.isFinite(raw)) return;
                    const nextCol = snapValue(clampNumber(raw, 0, gridCols - 1));
                    updateLayer(layer.id, { grid_position: [nextCol, snapValue(gridRow)] });
                  }}
                  className="w-full rounded bg-srve-bg border border-white/10 px-2 py-2 text-xs text-gray-200 disabled:opacity-60"
                />
              </div>

              <div className="space-y-1">
                <div className="text-[11px] text-gray-400">Row</div>
                <input
                  type="number"
                  disabled={isDisabled}
                  min={0}
                  max={Math.max(0, gridRows - 1)}
                  step={gridStep}
                  value={snapValue(gridRow)}
                  onChange={(e) => {
                    if (!layer) return;
                    const raw = Number(e.target.value);
                    if (!Number.isFinite(raw)) return;
                    const nextRow = snapValue(clampNumber(raw, 0, gridRows - 1));
                    updateLayer(layer.id, { grid_position: [snapValue(gridCol), nextRow] });
                  }}
                  className="w-full rounded bg-srve-bg border border-white/10 px-2 py-2 text-xs text-gray-200 disabled:opacity-60"
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded bg-white/5 border border-white/10 px-3 py-2">
              <div className="text-xs text-gray-200">Grid Preview</div>
              <div
                className="w-[84px] h-[56px] rounded bg-srve-bg border border-white/10 p-1"
                style={{ display: 'grid', gridTemplateColumns: `repeat(${gridCols}, 1fr)`, gridTemplateRows: `repeat(${gridRows}, 1fr)`, gap: 2 }}
              >
                {Array.from({ length: gridCols * gridRows }, (_, idx) => {
                  const col = idx % gridCols;
                  const row = Math.floor(idx / gridCols);
                  const active = col === gridCol && row === gridRow;
                  return (
                    <div
                      key={idx}
                      className={active ? 'rounded bg-srve-accent/60 border border-srve-accent/70' : 'rounded bg-white/5 border border-white/10'}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-white/10" />

        <div>
          <div className="text-xs font-semibold text-white">Flip</div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            {([
              { label: 'None', value: FlipMode.NONE },
              { label: 'Alternating', value: FlipMode.ALTERNATING },
              { label: 'Rotation CW', value: FlipMode.ROTATION_CW },
              { label: 'Rotation CCW', value: FlipMode.ROTATION_CCW },
            ] as const).map((opt) => {
              const checked = layer?.flip_mode === opt.value;
              return (
                <label
                  key={opt.value}
                  className={
                    checked
                      ? 'flex items-center gap-2 rounded bg-srve-accent/10 border border-srve-accent/30 px-3 py-2'
                      : 'flex items-center gap-2 rounded bg-white/5 border border-white/10 px-3 py-2 hover:bg-white/10'
                  }
                >
                  <input
                    type="radio"
                    name="flip-mode"
                    disabled={isDisabled}
                    checked={checked}
                    onChange={() => {
                      if (!layer) return;
                      updateLayer(layer.id, { flip_mode: opt.value });
                    }}
                    className="accent-srve-accent disabled:opacity-60"
                  />
                  <FlipIcon mode={opt.value} />
                  <div className="text-xs text-gray-200">{opt.label}</div>
                </label>
              );
            })}
          </div>
        </div>

        <div className="border-t border-white/10" />

        <div>
          <div className="text-xs font-semibold text-white">Effects</div>

          <div className="mt-2 space-y-2">
            <label className="flex items-center justify-between rounded bg-white/5 border border-white/10 px-3 py-2">
              <div className="text-xs text-gray-200">Velocity → Opacity</div>
              <input
                type="checkbox"
                disabled={isDisabled}
                checked={layer?.velocity_opacity ?? true}
                onChange={(e) => {
                  if (!layer) return;
                  updateLayer(layer.id, { velocity_opacity: e.target.checked });
                }}
                className="accent-srve-accent disabled:opacity-60"
              />
            </label>

            <label className="flex items-center justify-between rounded bg-white/5 border border-white/10 px-3 py-2">
              <div className="text-xs text-gray-200">Black &amp; White</div>
              <input
                type="checkbox"
                disabled={isDisabled}
                checked={layer?.effects.black_and_white ?? false}
                onChange={(e) => setEffects({ black_and_white: e.target.checked })}
                className="accent-srve-accent disabled:opacity-60"
              />
            </label>

            <div className="rounded bg-white/5 border border-white/10 p-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-200">Wave Effect</div>
                <input
                  type="checkbox"
                  disabled={isDisabled}
                  checked={layer?.effects.wave_enabled ?? false}
                  onChange={(e) => setEffects({ wave_enabled: e.target.checked })}
                  className="accent-srve-accent disabled:opacity-60"
                />
              </div>

              <div className="mt-2 grid grid-cols-1 gap-2">
                <div className="space-y-1">
                  <div className="text-[11px] text-gray-400">Amplitude</div>
                  <input
                    type="range"
                    disabled={isDisabled || !layer?.effects.wave_enabled}
                    min={1}
                    max={50}
                    step={1}
                    value={clampNumber(layer?.effects.wave_amplitude ?? 10, 1, 50)}
                    onChange={(e) => setEffects({ wave_amplitude: clampNumber(Number(e.target.value), 1, 50) })}
                    className="w-full disabled:opacity-60"
                  />
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] text-gray-400">Frequency</div>
                  <input
                    type="range"
                    disabled={isDisabled || !layer?.effects.wave_enabled}
                    min={0.5}
                    max={10}
                    step={0.1}
                    value={clampNumber(layer?.effects.wave_frequency ?? 2, 0.5, 10)}
                    onChange={(e) => setEffects({ wave_frequency: clampNumber(Number(e.target.value), 0.5, 10) })}
                    className="w-full disabled:opacity-60"
                  />
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] text-gray-400">Speed</div>
                  <input
                    type="range"
                    disabled={isDisabled || !layer?.effects.wave_enabled}
                    min={0.1}
                    max={5}
                    step={0.1}
                    value={clampNumber(layer?.effects.wave_speed ?? 1, 0.1, 5)}
                    onChange={(e) => setEffects({ wave_speed: clampNumber(Number(e.target.value), 0.1, 5) })}
                    className="w-full disabled:opacity-60"
                  />
                </div>
              </div>
            </div>

            <div className="rounded bg-white/5 border border-white/10 p-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-200">Zoom Effect</div>
                <input
                  type="checkbox"
                  disabled={isDisabled}
                  checked={layer?.effects.zoom.enabled ?? false}
                  onChange={(e) => {
                    if (!layer) return;
                    setEffects({ zoom: { ...layer.effects.zoom, enabled: e.target.checked } });
                  }}
                  className="accent-srve-accent disabled:opacity-60"
                />
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <div className="text-[11px] text-gray-400">Start Scale</div>
                  <input
                    type="range"
                    disabled={isDisabled || !layer?.effects.zoom.enabled}
                    min={0.5}
                    max={2}
                    step={0.01}
                    value={clampNumber(layer?.effects.zoom.start_scale ?? 1, 0.5, 2)}
                    onChange={(e) => {
                      if (!layer) return;
                      setEffects({ zoom: { ...layer.effects.zoom, start_scale: clampNumber(Number(e.target.value), 0.5, 2) } });
                    }}
                    className="w-full disabled:opacity-60"
                  />
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] text-gray-400">End Scale</div>
                  <input
                    type="range"
                    disabled={isDisabled || !layer?.effects.zoom.enabled}
                    min={0.5}
                    max={2}
                    step={0.01}
                    value={clampNumber(layer?.effects.zoom.end_scale ?? 1.2, 0.5, 2)}
                    onChange={(e) => {
                      if (!layer) return;
                      setEffects({ zoom: { ...layer.effects.zoom, end_scale: clampNumber(Number(e.target.value), 0.5, 2) } });
                    }}
                    className="w-full disabled:opacity-60"
                  />
                </div>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <div className="text-[11px] text-gray-400">Easing</div>
                  <select
                    disabled={isDisabled || !layer?.effects.zoom.enabled}
                    value={layer?.effects.zoom.easing ?? EasingType.LINEAR}
                    onChange={(e) => {
                      if (!layer) return;
                      setEffects({ zoom: { ...layer.effects.zoom, easing: e.target.value as EasingType } });
                    }}
                    className="w-full rounded bg-srve-bg border border-white/10 px-2 py-2 text-xs text-gray-200 disabled:opacity-60"
                  >
                    <option value={EasingType.LINEAR}>Linear</option>
                    <option value={EasingType.EASE_OUT}>Ease Out</option>
                    <option value={EasingType.EASE_IN}>Ease In</option>
                    <option value={EasingType.EASE_SMOOTH}>Smooth</option>
                    <option value={EasingType.ELASTIC}>Elastic</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] text-gray-400">Intensity</div>
                  <input
                    type="range"
                    disabled={isDisabled || !layer?.effects.zoom.enabled}
                    min={0.1}
                    max={3}
                    step={0.1}
                    value={clampNumber(layer?.effects.zoom.easing_intensity ?? 1, 0.1, 3)}
                    onChange={(e) => {
                      if (!layer) return;
                      setEffects({ zoom: { ...layer.effects.zoom, easing_intensity: clampNumber(Number(e.target.value), 0.1, 3) } });
                    }}
                    className="w-full disabled:opacity-60"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
