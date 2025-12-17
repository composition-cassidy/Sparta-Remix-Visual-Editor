import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getVideoFrame, getVideoWaveform, type VideoWaveformResponse } from '../../api/client';
import { VideoPreview } from './components/VideoPreview';
import { TransportControls } from './components/TransportControls';
import { TimelineRuler } from './components/TimelineRuler';
import { TimelineTrack } from './components/TimelineTrack';
import { ZoomControls } from './components/ZoomControls';
import { TimecodeInputs } from './components/TimecodeInputs';
import { CacheControls } from './components/CacheControls';

type TrimmerParams = {
  videoPath: string;
  videoName: string;
  videoDuration: number;
  videoFps: number;
  currentIn: number;
  currentOut: number;
  layerId: string;
};

function parseUrlParams(): TrimmerParams {
  const params = new URLSearchParams(window.location.search);
  return {
    videoPath: params.get('videoPath') ?? '',
    videoName: params.get('videoName') ?? 'Untitled',
    videoDuration: Number(params.get('videoDuration')) || 0,
    videoFps: Number(params.get('videoFps')) || 30,
    currentIn: Number(params.get('currentIn')) || 0,
    currentOut: Number(params.get('currentOut')) || 0,
    layerId: params.get('layerId') ?? '',
  };
}

function formatTimecode(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(ms % 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(millis).padStart(3, '0')}`;
}

export function TrimmerWindow() {
  const params = useMemo(() => parseUrlParams(), []);
  const { videoPath, videoName, videoDuration, videoFps, layerId } = params;

  const [inPoint, setInPoint] = useState(params.currentIn);
  const [outPoint, setOutPoint] = useState(
    params.currentOut <= 0 || params.currentOut > videoDuration ? videoDuration : params.currentOut,
  );
  const [playheadMs, setPlayheadMs] = useState(params.currentIn);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);

  const [zoom, setZoom] = useState(1);
  const [scrollOffset, setScrollOffset] = useState(0);

  const [previewFrame, setPreviewFrame] = useState<string | null>(null);
  const [isLoadingFrame, setIsLoadingFrame] = useState(false);
  const [waveform, setWaveform] = useState<VideoWaveformResponse | null>(null);
  const [thumbnailsEnabled, setThumbnailsEnabled] = useState(true);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playbackRafRef = useRef<number | null>(null);
  const frameRequestRef = useRef<AbortController | null>(null);

  const frameDurationMs = useMemo(() => (videoFps > 0 ? 1000 / videoFps : 33.33), [videoFps]);

  useEffect(() => {
    if (!videoPath) return;
    getVideoWaveform(videoPath, 200)
      .then(setWaveform)
      .catch(() => {});
  }, [videoPath]);

  useEffect(() => {
    if (!videoPath || isPlaying) return;

    if (frameRequestRef.current) {
      frameRequestRef.current.abort();
    }
    frameRequestRef.current = new AbortController();

    setIsLoadingFrame(true);
    getVideoFrame(videoPath, playheadMs, 640)
      .then((res) => {
        setPreviewFrame(`data:image/jpeg;base64,${res.image_base64}`);
      })
      .catch(() => {})
      .finally(() => setIsLoadingFrame(false));

    return () => {
      if (frameRequestRef.current) {
        frameRequestRef.current.abort();
      }
    };
  }, [videoPath, playheadMs, isPlaying]);

  const handlePlay = useCallback(() => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = playheadMs / 1000;
    videoRef.current.volume = volume;
    videoRef.current.play().catch(() => {});
    setIsPlaying(true);

    const animate = () => {
      if (!videoRef.current) return;
      const currentMs = videoRef.current.currentTime * 1000;
      setPlayheadMs(currentMs);

      if (currentMs >= outPoint) {
        videoRef.current.pause();
        setIsPlaying(false);
        setPlayheadMs(outPoint);
        return;
      }

      playbackRafRef.current = requestAnimationFrame(animate);
    };
    playbackRafRef.current = requestAnimationFrame(animate);
  }, [playheadMs, volume, outPoint]);

  const handlePause = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.pause();
    }
    if (playbackRafRef.current) {
      cancelAnimationFrame(playbackRafRef.current);
      playbackRafRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  const handleTogglePlay = useCallback(() => {
    if (isPlaying) {
      handlePause();
    } else {
      handlePlay();
    }
  }, [isPlaying, handlePlay, handlePause]);

  const handleSeek = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, Math.min(videoDuration, ms));
      setPlayheadMs(clamped);
      if (videoRef.current) {
        videoRef.current.currentTime = clamped / 1000;
      }
    },
    [videoDuration],
  );

  const handlePrevFrame = useCallback(() => {
    handleSeek(Math.max(0, playheadMs - frameDurationMs));
  }, [playheadMs, frameDurationMs, handleSeek]);

  const handleNextFrame = useCallback(() => {
    handleSeek(Math.min(videoDuration, playheadMs + frameDurationMs));
  }, [playheadMs, frameDurationMs, videoDuration, handleSeek]);

  const handleJumpToIn = useCallback(() => {
    handleSeek(inPoint);
  }, [inPoint, handleSeek]);

  const handleJumpToOut = useCallback(() => {
    handleSeek(outPoint);
  }, [outPoint, handleSeek]);

  const handleSetIn = useCallback(() => {
    const newIn = Math.min(playheadMs, outPoint - frameDurationMs);
    setInPoint(Math.max(0, newIn));
  }, [playheadMs, outPoint, frameDurationMs]);

  const handleSetOut = useCallback(() => {
    const newOut = Math.max(playheadMs, inPoint + frameDurationMs);
    setOutPoint(Math.min(videoDuration, newOut));
  }, [playheadMs, inPoint, frameDurationMs, videoDuration]);

  const handleRewind = useCallback(() => {
    handleSeek(Math.max(0, playheadMs - 1000));
  }, [playheadMs, handleSeek]);

  const handleFastForward = useCallback(() => {
    handleSeek(Math.min(videoDuration, playheadMs + 1000));
  }, [playheadMs, videoDuration, handleSeek]);

  const handlePreviewSelection = useCallback(() => {
    handleSeek(inPoint);
    setTimeout(() => handlePlay(), 50);
  }, [inPoint, handleSeek, handlePlay]);

  const handleResetToFull = useCallback(() => {
    setInPoint(0);
    setOutPoint(videoDuration);
  }, [videoDuration]);

  const handleCancel = useCallback(() => {
    window.srve?.closeTrimmer?.({
      layerId,
      inPoint: params.currentIn,
      outPoint: params.currentOut,
      cancelled: true,
    });
  }, [layerId, params.currentIn, params.currentOut]);

  const handleApply = useCallback(() => {
    window.srve?.closeTrimmer?.({
      layerId,
      inPoint,
      outPoint,
      cancelled: false,
    });
  }, [layerId, inPoint, outPoint]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          handleTogglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) {
            handleRewind();
          } else if (e.ctrlKey || e.metaKey) {
            handleJumpToIn();
          } else {
            handlePrevFrame();
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) {
            handleFastForward();
          } else if (e.ctrlKey || e.metaKey) {
            handleJumpToOut();
          } else {
            handleNextFrame();
          }
          break;
        case 'Home':
          e.preventDefault();
          handleJumpToIn();
          break;
        case 'End':
          e.preventDefault();
          handleJumpToOut();
          break;
        case 'i':
        case 'I':
          e.preventDefault();
          handleSetIn();
          break;
        case 'o':
        case 'O':
          e.preventDefault();
          handleSetOut();
          break;
        case 'Escape':
          e.preventDefault();
          handleCancel();
          break;
        case 'Enter':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleApply();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    handleTogglePlay,
    handlePrevFrame,
    handleNextFrame,
    handleJumpToIn,
    handleJumpToOut,
    handleSetIn,
    handleSetOut,
    handleRewind,
    handleFastForward,
    handleCancel,
    handleApply,
  ]);

  useEffect(() => {
    return () => {
      if (playbackRafRef.current) {
        cancelAnimationFrame(playbackRafRef.current);
      }
    };
  }, []);

  const videoSrc = videoPath ? `file://${videoPath}` : '';

  return (
    <div className="flex flex-col h-screen bg-srve-bg text-white select-none">

      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-srve-panel border-b border-white/10">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium truncate max-w-[300px]">{videoName}</span>
          <span className="text-xs text-gray-400">{videoFps.toFixed(2)} fps</span>
        </div>
        <div className="text-xs text-gray-400">
          Press <kbd className="px-1 py-0.5 bg-white/10 rounded text-[10px]">?</kbd> for shortcuts
        </div>
      </div>

      {/* Video Preview */}
      <div className="flex-1 min-h-0 bg-black flex items-center justify-center p-4">
        <VideoPreview
          frameSrc={previewFrame}
          isLoading={isLoadingFrame}
          isPlaying={isPlaying}
          videoSrc={videoSrc}
          videoRef={videoRef}
          onEnded={handlePause}
        />
      </div>

      {/* Transport Controls */}
      <TransportControls
        isPlaying={isPlaying}
        currentTime={playheadMs}
        volume={volume}
        onTogglePlay={handleTogglePlay}
        onPrevFrame={handlePrevFrame}
        onNextFrame={handleNextFrame}
        onRewind={handleRewind}
        onFastForward={handleFastForward}
        onJumpToIn={handleJumpToIn}
        onJumpToOut={handleJumpToOut}
        onVolumeChange={setVolume}
        formatTime={formatTimecode}
      />

      {/* Timeline Ruler */}
      <TimelineRuler
        duration={videoDuration}
        zoom={zoom}
        scrollOffset={scrollOffset}
        onSeek={handleSeek}
      />

      {/* Timeline Track */}
      <TimelineTrack
        videoPath={videoPath}
        duration={videoDuration}
        inPoint={inPoint}
        outPoint={outPoint}
        playhead={playheadMs}
        zoom={zoom}
        scrollOffset={scrollOffset}
        waveform={waveform}
        thumbnailsEnabled={thumbnailsEnabled}
        onInPointChange={setInPoint}
        onOutPointChange={setOutPoint}
        onPlayheadChange={handleSeek}
        onScrollChange={setScrollOffset}
        onZoomChange={setZoom}
      />

      {/* Bottom Controls */}
      <div className="flex items-center justify-between px-4 py-3 bg-srve-panel border-t border-white/10">
        <div className="flex items-center gap-3">
          <ZoomControls
            zoom={zoom}
            onZoomChange={setZoom}
            onFitAll={() => setZoom(1)}
            onFitSelection={() => {
              const selectionDuration = outPoint - inPoint;
              if (selectionDuration > 0) {
                setZoom(videoDuration / selectionDuration);
                setScrollOffset(inPoint / videoDuration);
              }
            }}
          />
          <div className="w-px h-6 bg-white/20" />
          <CacheControls onThumbnailsToggle={setThumbnailsEnabled} />
        </div>

        <TimecodeInputs
          inPoint={inPoint}
          outPoint={outPoint}
          duration={videoDuration}
          onInPointChange={setInPoint}
          onOutPointChange={setOutPoint}
          formatTime={formatTimecode}
        />
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-center gap-3 px-4 py-3 bg-srve-panel border-t border-white/10">
        <button
          onClick={handleResetToFull}
          className="px-4 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors"
        >
          Reset to Full
        </button>
        <button
          onClick={handlePreviewSelection}
          className="px-4 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors"
        >
          Preview Selection
        </button>
        <div className="w-px h-6 bg-white/20" />
        <button
          onClick={handleCancel}
          className="px-4 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleApply}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors font-medium"
        >
          Apply
        </button>
      </div>
    </div>
  );
}
