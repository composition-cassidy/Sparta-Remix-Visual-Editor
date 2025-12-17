import { useEffect, useMemo, useRef, useState } from 'react';

import { analyzeAudio, analyzeVideo, getVideoThumbnail, importMidi } from '../../api/client';
import { useProjectStore } from '../../stores/projectStore';
import type { SourceVideo } from '../../types';

type ContextMenuState = {
  x: number;
  y: number;
  videoId: string;
} | null;

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function SourcePanel() {
  const project = useProjectStore((s) => s.project);
  const addSourceVideo = useProjectStore((s) => s.addSourceVideo);
  const removeSourceVideo = useProjectStore((s) => s.removeSourceVideo);
  const midiData = useProjectStore((s) => s.midiData);
  const setMidiData = useProjectStore((s) => s.setMidiData);
  const setMidiFilePath = useProjectStore((s) => s.setMidiFilePath);
  const setBpm = useProjectStore((s) => s.setBpm);
  const bgm = useProjectStore((s) => s.bgm);
  const setBgm = useProjectStore((s) => s.setBgm);
  const setBgmOffset = useProjectStore((s) => s.setBgmOffset);
  const chorusVideo = useProjectStore((s) => s.chorusVideo);
  const setChorusVideo = useProjectStore((s) => s.setChorusVideo);
  const setChorusOffset = useProjectStore((s) => s.setChorusOffset);

  const [error, setError] = useState<string | null>(null);
  const [midiError, setMidiError] = useState<string | null>(null);
  const [bgmError, setBgmError] = useState<string | null>(null);
  const [chorusError, setChorusError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [midiImporting, setMidiImporting] = useState(false);
  const [bgmImporting, setBgmImporting] = useState(false);
  const [chorusImporting, setChorusImporting] = useState(false);
  const [bpmInput, setBpmInput] = useState('');
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [bgmOffsetInput, setBgmOffsetInput] = useState('0');
  const [chorusOffsetInput, setChorusOffsetInput] = useState('0');

  const loadingThumbIds = useRef(new Set<string>());

  const videos = project?.source_videos ?? [];
  const existingPathSet = useMemo(() => {
    const set = new Set<string>();
    for (const v of videos) {
      set.add(v.path.toLowerCase());
    }
    return set;
  }, [videos]);

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

    async function load(video: SourceVideo) {
      if (thumbnails[video.id]) return;
      if (loadingThumbIds.current.has(video.id)) return;

      loadingThumbIds.current.add(video.id);
      try {
        const res = await getVideoThumbnail(video.path, 0);
        if (cancelled) return;
        setThumbnails((prev) => ({
          ...prev,
          [video.id]: `data:image/jpeg;base64,${res.image_base64}`,
        }));
      } catch (err: unknown) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        loadingThumbIds.current.delete(video.id);
      }
    }

    videos.forEach((video) => {
      void load(video);
    });

    return () => {
      cancelled = true;
    };
  }, [videos, thumbnails]);

  useEffect(() => {
    if (project?.bpm != null) {
      setBpmInput(String(project.bpm));
      return;
    }
    if (midiData) {
      setBpmInput(String(midiData.bpm));
      return;
    }
    setBpmInput('');
  }, [project?.bpm, midiData]);

  const midiChannels = useMemo(() => {
    if (!midiData) return [];
    return Object.keys(midiData.channels)
      .map((key) => Number(key))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  }, [midiData]);

  const midiFilename = useMemo(() => {
    const path = project?.midi_file_path;
    if (!path) return null;
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
  }, [project?.midi_file_path]);

  const bgmFilename = useMemo(() => {
    const path = bgm?.path ?? project?.bgm_path;
    if (!path) return null;
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
  }, [bgm?.path, project?.bgm_path]);

  const chorusFilename = useMemo(() => {
    const path = chorusVideo?.path ?? project?.chorus_video_path;
    if (!path) return null;
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
  }, [chorusVideo?.path, project?.chorus_video_path]);

  useEffect(() => {
    setBgmOffsetInput(String(project?.bgm_offset_ms ?? 0));
  }, [project?.bgm_offset_ms]);

  useEffect(() => {
    setChorusOffsetInput(String(project?.chorus_offset_ms ?? 0));
  }, [project?.chorus_offset_ms]);

  async function onImportMidi() {
    setMidiError(null);

    const openDialog = window.srve?.openMidiDialog;
    if (!openDialog) {
      setMidiError('MIDI dialog is not available.');
      return;
    }

    setMidiImporting(true);
    try {
      const selectedPaths = await openDialog();
      if (!selectedPaths || selectedPaths.length === 0) {
        return;
      }

      const selected = selectedPaths[0];
      if (!selected) return;

      const data = await importMidi(selected);
      setMidiData(data);
      setMidiFilePath(selected);
      setBpm(data.bpm);
      setBpmInput(String(data.bpm));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setMidiError(message);
    } finally {
      setMidiImporting(false);
    }
  }

  async function onImportBgm() {
    setBgmError(null);

    const openDialog = window.srve?.openAudioDialog;
    if (!openDialog) {
      setBgmError('Audio dialog is not available.');
      return;
    }

    setBgmImporting(true);
    try {
      const selectedPaths = await openDialog();
      if (!selectedPaths || selectedPaths.length === 0) {
        return;
      }

      const selected = selectedPaths[0];
      if (!selected) return;

      const meta = await analyzeAudio(selected);
      setBgm({ path: meta.path, duration_ms: meta.duration_ms });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setBgmError(message);
    } finally {
      setBgmImporting(false);
    }
  }

  async function onImportChorusVideo() {
    setChorusError(null);

    const openDialog = window.srve?.openVideoDialog;
    if (!openDialog) {
      setChorusError('Video dialog is not available.');
      return;
    }

    setChorusImporting(true);
    try {
      const selectedPaths = await openDialog();
      if (!selectedPaths || selectedPaths.length === 0) {
        return;
      }

      const selected = selectedPaths[0];
      if (!selected) return;

      const video = await analyzeVideo(selected);
      setChorusVideo(video);
      const res = await getVideoThumbnail(video.path, 0);
      setThumbnails((prev) => ({
        ...prev,
        [video.id]: `data:image/jpeg;base64,${res.image_base64}`,
      }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setChorusError(message);
    } finally {
      setChorusImporting(false);
    }
  }

  function commitBgmOffset() {
    const raw = bgmOffsetInput.trim();
    const value = raw ? Number(raw) : 0;
    if (!Number.isFinite(value)) {
      setBgmError('Invalid BGM offset.');
      setBgmOffsetInput(String(project?.bgm_offset_ms ?? 0));
      return;
    }
    setBgmOffset(Math.trunc(value));
  }

  function commitChorusOffset() {
    const raw = chorusOffsetInput.trim();
    const value = raw ? Number(raw) : 0;
    if (!Number.isFinite(value)) {
      setChorusError('Invalid chorus offset.');
      setChorusOffsetInput(String(project?.chorus_offset_ms ?? 0));
      return;
    }
    setChorusOffset(Math.trunc(value));
  }

  function commitBpmOverride() {
    const raw = bpmInput.trim();
    if (!raw) {
      if (midiData) {
        setBpm(midiData.bpm);
        setBpmInput(String(midiData.bpm));
      } else {
        setBpm(null);
      }
      return;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      setMidiError('Invalid BPM value.');
      setBpmInput(project?.bpm != null ? String(project.bpm) : '');
      return;
    }

    setBpm(value);
  }

  async function onAddVideo() {
    setError(null);

    const openDialog = window.srve?.openVideoDialog;
    if (!openDialog) {
      setError('Video dialog is not available.');
      return;
    }

    setImporting(true);
    try {
      const selectedPaths = await openDialog();
      if (!selectedPaths || selectedPaths.length === 0) {
        return;
      }

      const unique = new Set<string>();
      for (const p of selectedPaths) {
        if (!p) continue;
        const key = p.toLowerCase();
        if (existingPathSet.has(key)) continue;
        unique.add(p);
      }

      for (const p of unique) {
        const video = await analyzeVideo(p);
        addSourceVideo(video);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setImporting(false);
    }
  }

  function handleRemove(videoId: string) {
    removeSourceVideo(videoId);
    setThumbnails((prev) => {
      const next = { ...prev };
      delete next[videoId];
      return next;
    });
    loadingThumbIds.current.delete(videoId);
    setContextMenu(null);
  }

  return (
    <div className="h-full p-3 flex flex-col overflow-auto">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-white">MIDI File</div>
        <button
          type="button"
          onClick={onImportMidi}
          disabled={midiImporting || !window.srve?.openMidiDialog}
          className={
            midiImporting || !window.srve?.openMidiDialog
              ? 'text-xs px-2 py-1 rounded bg-srve-accent/20 text-srve-accent border border-srve-accent/30 opacity-60 cursor-not-allowed'
              : 'text-xs px-2 py-1 rounded bg-srve-accent/20 text-srve-accent border border-srve-accent/30 hover:bg-srve-accent/30'
          }
        >
          {midiImporting ? 'Importing…' : 'Import MIDI'}
        </button>
      </div>

      <div className="mt-2 min-h-[16px] text-[11px] text-red-400">{midiError ?? ''}</div>

      <div className="mt-1 rounded bg-white/5 border border-white/10 p-2">
        <div className="text-[11px] text-gray-400">File</div>
        <div className="text-xs text-gray-200 truncate">{midiFilename ?? 'No MIDI selected.'}</div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <div className="text-[11px] text-gray-400">BPM</div>
            <input
              type="text"
              value={bpmInput}
              onChange={(e) => setBpmInput(e.target.value)}
              onBlur={commitBpmOverride}
              placeholder={midiData ? String(midiData.bpm) : ''}
              className="w-full rounded bg-srve-bg border border-white/10 px-2 py-1 text-xs text-gray-200"
            />
          </div>

          <div className="space-y-1">
            <div className="text-[11px] text-gray-400">Duration</div>
            <div className="text-xs text-gray-200">
              {midiData ? formatDuration(midiData.duration_ms) : '--'}
            </div>
          </div>
        </div>

        <div className="mt-2 text-[11px] text-gray-400">Channels ({midiChannels.length})</div>
        <div className="text-xs text-gray-200">{midiChannels.length ? midiChannels.join(', ') : '--'}</div>
      </div>

      <div className="mt-3 border-t border-white/10" />

      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-white">Backing Track (BGM)</div>
        <button
          type="button"
          onClick={onImportBgm}
          disabled={bgmImporting || !window.srve?.openAudioDialog}
          className={
            bgmImporting || !window.srve?.openAudioDialog
              ? 'text-xs px-2 py-1 rounded bg-srve-accent/20 text-srve-accent border border-srve-accent/30 opacity-60 cursor-not-allowed'
              : 'text-xs px-2 py-1 rounded bg-srve-accent/20 text-srve-accent border border-srve-accent/30 hover:bg-srve-accent/30'
          }
        >
          {bgmImporting ? 'Importing…' : 'Import Audio'}
        </button>
      </div>

      <div className="mt-2 min-h-[16px] text-[11px] text-red-400">{bgmError ?? ''}</div>

      <div className="mt-1 rounded bg-white/5 border border-white/10 p-2">
        <div className="text-[11px] text-gray-400">File</div>
        <div className="text-xs text-gray-200 truncate">{bgmFilename ?? 'No audio selected.'}</div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <div className="text-[11px] text-gray-400">Duration</div>
            <div className="text-xs text-gray-200">{bgm ? formatDuration(bgm.duration_ms) : '--'}</div>
          </div>

          <div className="space-y-1">
            <div className="text-[11px] text-gray-400">Offset (ms)</div>
            <input
              type="text"
              value={bgmOffsetInput}
              onChange={(e) => setBgmOffsetInput(e.target.value)}
              onBlur={commitBgmOffset}
              className="w-full rounded bg-srve-bg border border-white/10 px-2 py-1 text-xs text-gray-200"
            />
          </div>
        </div>
      </div>

      <div className="mt-3 border-t border-white/10" />

      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-white">Background/Chorus Video</div>
        <button
          type="button"
          onClick={onImportChorusVideo}
          disabled={chorusImporting || !window.srve?.openVideoDialog}
          className={
            chorusImporting || !window.srve?.openVideoDialog
              ? 'text-xs px-2 py-1 rounded bg-srve-accent/20 text-srve-accent border border-srve-accent/30 opacity-60 cursor-not-allowed'
              : 'text-xs px-2 py-1 rounded bg-srve-accent/20 text-srve-accent border border-srve-accent/30 hover:bg-srve-accent/30'
          }
        >
          {chorusImporting ? 'Importing…' : 'Import Video'}
        </button>
      </div>

      <div className="mt-2 min-h-[16px] text-[11px] text-red-400">{chorusError ?? ''}</div>

      <div className="mt-1 rounded bg-white/5 border border-white/10 p-2">
        <div className="flex items-center gap-2">
          <div className="w-[76px] h-[44px] shrink-0 rounded bg-srve-bg border border-white/10 overflow-hidden flex items-center justify-center">
            {chorusVideo && thumbnails[chorusVideo.id] ? (
              <img
                src={thumbnails[chorusVideo.id]}
                alt={chorusVideo.name}
                className="w-full h-full object-cover"
                draggable={false}
              />
            ) : (
              <div className="text-[10px] text-gray-500">--</div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-gray-400">File</div>
            <div className="text-xs text-gray-200 truncate">{chorusFilename ?? 'No video selected.'}</div>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <div className="text-[11px] text-gray-400">Duration</div>
            <div className="text-xs text-gray-200">{chorusVideo ? formatDuration(chorusVideo.duration_ms) : '--'}</div>
          </div>

          <div className="space-y-1">
            <div className="text-[11px] text-gray-400">Offset (ms)</div>
            <input
              type="text"
              value={chorusOffsetInput}
              onChange={(e) => setChorusOffsetInput(e.target.value)}
              onBlur={commitChorusOffset}
              className="w-full rounded bg-srve-bg border border-white/10 px-2 py-1 text-xs text-gray-200"
            />
          </div>
        </div>
      </div>

      <div className="mt-3 border-t border-white/10" />

      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-white">Source Pool</div>
        <button
          type="button"
          onClick={onAddVideo}
          disabled={importing || !window.srve?.openVideoDialog}
          className={
            importing || !window.srve?.openVideoDialog
              ? 'text-xs px-2 py-1 rounded bg-srve-accent/20 text-srve-accent border border-srve-accent/30 opacity-60 cursor-not-allowed'
              : 'text-xs px-2 py-1 rounded bg-srve-accent/20 text-srve-accent border border-srve-accent/30 hover:bg-srve-accent/30'
          }
        >
          {importing ? 'Adding…' : 'Add Video'}
        </button>
      </div>

      <div className="mt-2 min-h-[16px] text-[11px] text-red-400">{error ?? ''}</div>

      <div className="mt-1 min-h-[40px]">
        {videos.length === 0 ? (
          <div className="text-xs text-gray-400">No source videos yet.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {videos.map((video) => {
              const thumb = thumbnails[video.id];
              return (
                <div
                  key={video.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      'application/x-srve-source-video',
                      JSON.stringify({ id: video.id, path: video.path }),
                    );
                    e.dataTransfer.setData('text/plain', video.path);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, videoId: video.id });
                  }}
                  className="flex items-center gap-2 p-2 rounded bg-white/5 border border-white/10 hover:bg-white/10 cursor-grab"
                >
                  <div className="w-[76px] h-[44px] shrink-0 rounded bg-srve-bg border border-white/10 overflow-hidden flex items-center justify-center">
                    {thumb ? (
                      <img src={thumb} alt={video.name} className="w-full h-full object-cover" draggable={false} />
                    ) : (
                      <div className="text-[10px] text-gray-500">Loading</div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-gray-100 truncate">{video.name}</div>
                    <div className="mt-0.5 text-[11px] text-gray-400">
                      {formatDuration(video.duration_ms)}
                      <span className="text-gray-600">{' | '}</span>
                      {video.width}x{video.height}
                    </div>
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
            onClick={() => handleRemove(contextMenu.videoId)}
            className="block w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-white/10"
          >
            Remove from pool
          </button>
        </div>
      ) : null}
    </div>
  );
}
