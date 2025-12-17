import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';

import { getVideoThumbnail } from '../../api/client';
import { useProjectStore } from '../../stores/projectStore';
import type { Layer, SourceVideo } from '../../types';

type ContextMenuState = {
  x: number;
  y: number;
  layerId: string;
} | null;

function GripIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="3" cy="3" r="1" fill="currentColor" />
      <circle cx="9" cy="3" r="1" fill="currentColor" />
      <circle cx="3" cy="6" r="1" fill="currentColor" />
      <circle cx="9" cy="6" r="1" fill="currentColor" />
      <circle cx="3" cy="9" r="1" fill="currentColor" />
      <circle cx="9" cy="9" r="1" fill="currentColor" />
    </svg>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M3 3l18 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M4.5 7.5C2.9 9.2 2 11 2 12s3.5 7 10 7c1.8 0 3.3-.4 4.6-1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M9.9 5.2C10.6 5.1 11.3 5 12 5c6.5 0 10 7 10 7s-.9 1.9-2.6 3.7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M10 10a3 3 0 0 0 4 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function LayerPanel() {
  const project = useProjectStore((s) => s.project);
  const selectedLayerId = useProjectStore((s) => s.selectedLayerId);
  const selectLayer = useProjectStore((s) => s.selectLayer);
  const addLayer = useProjectStore((s) => s.addLayer);
  const duplicateLayer = useProjectStore((s) => s.duplicateLayer);
  const removeLayer = useProjectStore((s) => s.removeLayer);
  const updateLayer = useProjectStore((s) => s.updateLayer);
  const reorderLayers = useProjectStore((s) => s.reorderLayers);
  const previewFrame = useProjectStore((s) => s.previewFrame);

  const layers = project?.layers ?? [];
  const videos = project?.source_videos ?? [];

  const sortedLayers = useMemo(() => {
    return [...layers].sort((a, b) => a.order - b.order);
  }, [layers]);

  const activeClipByLayerId = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of previewFrame?.active_layers ?? []) {
      map.set(entry.layer_id, entry.clip_index);
    }
    return map;
  }, [previewFrame?.active_layers]);

  const videoById = useMemo(() => {
    const map = new Map<string, SourceVideo>();
    for (const v of videos) map.set(v.id, v);
    return map;
  }, [videos]);

  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  const [dragOverLayerId, setDragOverLayerId] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const loadingThumbIds = useRef(new Set<string>());

  const layerCount = sortedLayers.length;
  const showPerfWarning = layerCount >= 30;

  useEffect(() => {
    if (!contextMenu) return;

    const close = () => setContextMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', close);
    };
  }, [contextMenu]);

  useEffect(() => {
    let cancelled = false;

    async function loadThumb(video: SourceVideo) {
      if (thumbs[video.id]) return;
      if (loadingThumbIds.current.has(video.id)) return;

      loadingThumbIds.current.add(video.id);
      try {
        const res = await getVideoThumbnail(video.path, 0);
        if (cancelled) return;
        setThumbs((prev) => ({
          ...prev,
          [video.id]: `data:image/jpeg;base64,${res.image_base64}`,
        }));
      } finally {
        loadingThumbIds.current.delete(video.id);
      }
    }

    for (const layer of sortedLayers) {
      if (!layer.source_video_id) continue;
      const video = videoById.get(layer.source_video_id);
      if (!video) continue;
      void loadThumb(video);
    }

    return () => {
      cancelled = true;
    };
  }, [sortedLayers, thumbs, videoById]);

  function startRename(layer: Layer) {
    setEditingLayerId(layer.id);
    setNameDraft(layer.name);
  }

  function commitRename(layerId: string) {
    const next = nameDraft.trim();
    setEditingLayerId(null);
    if (!next) return;
    updateLayer(layerId, { name: next });
  }

  function cancelRename() {
    setEditingLayerId(null);
  }

  function moveLayerBy(delta: -1 | 1, layerId: string) {
    const index = sortedLayers.findIndex((l) => l.id === layerId);
    if (index < 0) return;
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= sortedLayers.length) return;

    const reordered = [...sortedLayers];
    const [picked] = reordered.splice(index, 1);
    if (!picked) return;
    reordered.splice(nextIndex, 0, picked);
    reorderLayers(reordered.map((l) => l.id));
  }

  function handleLayerDragStart(e: ReactDragEvent, layerId: string) {
    setDraggingLayerId(layerId);
    e.dataTransfer.setData('application/x-srve-layer', JSON.stringify({ id: layerId }));
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleLayerDragEnd() {
    setDraggingLayerId(null);
    setDragOverLayerId(null);
  }

  function handleLayerDragOver(e: ReactDragEvent, layer: Layer) {
    const types = Array.from(e.dataTransfer.types);
    const isSource = types.includes('application/x-srve-source-video');
    const isLayer = types.includes('application/x-srve-layer');

    if (isSource || isLayer) {
      e.preventDefault();
      e.dataTransfer.dropEffect = isSource ? 'copy' : 'move';
      setDragOverLayerId(layer.id);
    }
  }

  function handleLayerDragLeave(layerId: string) {
    setDragOverLayerId((prev) => (prev === layerId ? null : prev));
  }

  function handleLayerDrop(e: ReactDragEvent, targetLayer: Layer) {
    e.preventDefault();
    const types = Array.from(e.dataTransfer.types);

    if (types.includes('application/x-srve-source-video')) {
      const raw = e.dataTransfer.getData('application/x-srve-source-video');
      try {
        const parsed = JSON.parse(raw) as { id: string };
        if (parsed?.id) {
          updateLayer(targetLayer.id, { source_video_id: parsed.id });
        }
      } catch {
      } finally {
        setDragOverLayerId(null);
      }
      return;
    }

    if (types.includes('application/x-srve-layer')) {
      const raw = e.dataTransfer.getData('application/x-srve-layer');
      try {
        const parsed = JSON.parse(raw) as { id: string };
        const draggedId = parsed?.id ?? draggingLayerId;
        if (!draggedId) return;
        if (draggedId === targetLayer.id) return;

        const reordered = [...sortedLayers];
        const fromIndex = reordered.findIndex((l) => l.id === draggedId);
        const targetIndex = reordered.findIndex((l) => l.id === targetLayer.id);
        if (fromIndex < 0 || targetIndex < 0) return;

        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const isAfter = e.clientY > rect.top + rect.height / 2;

        const [picked] = reordered.splice(fromIndex, 1);
        if (!picked) return;

        let insertIndex = targetIndex + (isAfter ? 1 : 0);
        if (fromIndex < insertIndex) insertIndex -= 1;
        insertIndex = Math.max(0, Math.min(reordered.length, insertIndex));
        reordered.splice(insertIndex, 0, picked);
        reorderLayers(reordered.map((l) => l.id));
      } catch {
      } finally {
        setDragOverLayerId(null);
      }
    }
  }

  return (
    <div className="h-full p-3 flex flex-col">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-white flex items-center gap-2">
          <span>Layers: {layerCount}</span>
          {showPerfWarning ? (
            <span
              className="text-xs text-yellow-400"
              title="High layer count may impact performance"
              aria-label="High layer count may impact performance"
            >
              !
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => addLayer()}
          className="text-xs px-2 py-1 rounded bg-srve-accent/20 text-srve-accent border border-srve-accent/30 hover:bg-srve-accent/30"
          title="Add layer"
        >
          +
        </button>
      </div>

      <div className="mt-3 flex-1 min-h-0 overflow-auto">
        {sortedLayers.length === 0 ? (
          <div className="text-xs text-gray-400">No layers yet.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {sortedLayers.map((layer) => {
              const isSelected = layer.id === selectedLayerId;
              const isEditing = layer.id === editingLayerId;
              const isDragOver = layer.id === dragOverLayerId;
              const source = layer.source_video_id ? videoById.get(layer.source_video_id) : null;
              const thumb = source ? thumbs[source.id] : null;

              return (
                <div
                  key={layer.id}
                  onDragOver={(e) => handleLayerDragOver(e, layer)}
                  onDragLeave={() => handleLayerDragLeave(layer.id)}
                  onDrop={(e) => handleLayerDrop(e, layer)}
                  onClick={() => selectLayer(layer.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, layerId: layer.id });
                  }}
                  className={
                    isSelected
                      ? isDragOver
                        ? 'flex items-center gap-2 p-2 rounded bg-srve-accent/20 border border-srve-accent/40'
                        : 'flex items-center gap-2 p-2 rounded bg-white/10 border border-white/20'
                      : isDragOver
                        ? 'flex items-center gap-2 p-2 rounded bg-srve-accent/10 border border-srve-accent/30'
                        : 'flex items-center gap-2 p-2 rounded bg-white/5 border border-white/10 hover:bg-white/10'
                  }
                >
                  <div
                    className="w-5 h-5 shrink-0 text-gray-400 cursor-grab"
                    draggable
                    onDragStart={(e) => handleLayerDragStart(e, layer.id)}
                    onDragEnd={handleLayerDragEnd}
                    title="Drag to reorder"
                  >
                    <GripIcon className="w-5 h-5" />
                  </div>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateLayer(layer.id, { enabled: !layer.enabled });
                    }}
                    className="w-7 h-7 rounded bg-white/5 border border-white/10 flex items-center justify-center text-gray-300 hover:bg-white/10"
                    title={layer.enabled ? 'Hide layer' : 'Show layer'}
                  >
                    {layer.enabled ? <EyeIcon className="w-4 h-4" /> : <EyeOffIcon className="w-4 h-4" />}
                  </button>

                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <input
                        autoFocus
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => commitRename(layer.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            (e.target as HTMLInputElement).blur();
                          }
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelRename();
                          }
                        }}
                        className="w-full rounded bg-srve-bg border border-white/10 px-2 py-1 text-xs text-gray-200"
                      />
                    ) : (
                      <div
                        className="text-xs text-gray-100 truncate"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          startRename(layer);
                        }}
                        title="Double-click to rename"
                      >
                        {layer.name}
                      </div>
                    )}
                    <div className="mt-0.5 text-[11px] text-gray-400 truncate">
                      {source ? source.name : 'Drop a source video here'}
                    </div>
                  </div>

                  <div className="shrink-0 text-[11px] px-2 py-1 rounded bg-white/5 border border-white/10 text-gray-300">
                    CH {layer.midi_channel}
                  </div>

                  {activeClipByLayerId.has(layer.id) ? (
                    <div className="shrink-0 text-[11px] px-2 py-1 rounded bg-green-500/10 border border-green-500/20 text-green-300">
                      Clip {activeClipByLayerId.get(layer.id)}
                    </div>
                  ) : null}

                  <div className="w-[64px] h-[36px] shrink-0 rounded bg-srve-bg border border-white/10 overflow-hidden flex items-center justify-center">
                    {thumb ? (
                      <img src={thumb} alt={source?.name ?? ''} className="w-full h-full object-cover" draggable={false} />
                    ) : (
                      <div className="text-[10px] text-gray-500">--</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {contextMenu ? (
        <div
          className="fixed z-50 bg-srve-panel border border-white/10 rounded shadow-lg overflow-hidden"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            onClick={() => {
              duplicateLayer(contextMenu.layerId);
              setContextMenu(null);
            }}
            className="block w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-white/10"
          >
            Duplicate Layer
          </button>
          <button
            type="button"
            onClick={() => {
              removeLayer(contextMenu.layerId);
              setContextMenu(null);
            }}
            className="block w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-white/10"
          >
            Delete Layer
          </button>
          <div className="border-t border-white/10" />
          <button
            type="button"
            onClick={() => {
              moveLayerBy(-1, contextMenu.layerId);
              setContextMenu(null);
            }}
            className="block w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-white/10"
          >
            Move Up
          </button>
          <button
            type="button"
            onClick={() => {
              moveLayerBy(1, contextMenu.layerId);
              setContextMenu(null);
            }}
            className="block w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-white/10"
          >
            Move Down
          </button>
        </div>
      ) : null}
    </div>
  );
}
