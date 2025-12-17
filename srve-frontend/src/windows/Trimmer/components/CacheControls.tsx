import { useCallback, useEffect, useState } from 'react';

import {
  clearCache,
  disableThumbnails,
  enableThumbnails,
  getCacheStatus,
  pauseCache,
  resumeCache,
  type CacheStatusResponse,
} from '../../../api/client';

type CacheControlsProps = {
  onThumbnailsToggle?: (enabled: boolean) => void;
};

export function CacheControls({ onThumbnailsToggle }: CacheControlsProps) {
  const [status, setStatus] = useState<CacheStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getCacheStatus();
      setStatus(s);
    } catch {
      // Ignore errors
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 2000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const handlePauseResume = useCallback(async () => {
    setIsLoading(true);
    try {
      if (status?.paused) {
        await resumeCache();
      } else {
        await pauseCache();
      }
      await refreshStatus();
    } finally {
      setIsLoading(false);
    }
  }, [status?.paused, refreshStatus]);

  const handleClearCache = useCallback(async () => {
    setIsLoading(true);
    try {
      await clearCache();
      await refreshStatus();
    } finally {
      setIsLoading(false);
    }
  }, [refreshStatus]);

  const handleToggleThumbnails = useCallback(async () => {
    setIsLoading(true);
    try {
      if (status?.thumbnails_disabled) {
        await enableThumbnails();
        onThumbnailsToggle?.(true);
      } else {
        await disableThumbnails();
        onThumbnailsToggle?.(false);
      }
      await refreshStatus();
    } finally {
      setIsLoading(false);
    }
  }, [status?.thumbnails_disabled, refreshStatus, onThumbnailsToggle]);

  const thumbnailsEnabled = !status?.thumbnails_disabled;
  const isPaused = status?.paused ?? false;
  const isGenerating = (status?.generating ?? 0) > 0;

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className={`px-3 py-1.5 text-xs rounded transition-colors flex items-center gap-1.5 ${
          !thumbnailsEnabled
            ? 'bg-orange-600/20 text-orange-400 hover:bg-orange-600/30'
            : isPaused
            ? 'bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30'
            : isGenerating
            ? 'bg-blue-600/20 text-blue-400 hover:bg-blue-600/30'
            : 'bg-white/10 text-gray-300 hover:bg-white/20'
        }`}
        disabled={isLoading}
      >
        {/* Icon */}
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        {!thumbnailsEnabled ? (
          'Thumbnails Off'
        ) : isPaused ? (
          'Paused'
        ) : isGenerating ? (
          `Caching... (${status?.generating})`
        ) : (
          'Thumbnails'
        )}
      </button>

      {showMenu && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />

          {/* Menu */}
          <div className="absolute bottom-full left-0 mb-2 bg-srve-panel border border-white/20 rounded-lg shadow-xl z-50 min-w-[200px] overflow-hidden">
            <div className="px-3 py-2 border-b border-white/10 text-xs text-gray-400">
              Thumbnail Cache
            </div>

            {/* Status */}
            <div className="px-3 py-2 text-xs border-b border-white/10">
              <div className="flex justify-between">
                <span className="text-gray-400">Status:</span>
                <span
                  className={
                    !thumbnailsEnabled
                      ? 'text-orange-400'
                      : isPaused
                      ? 'text-yellow-400'
                      : isGenerating
                      ? 'text-blue-400'
                      : 'text-green-400'
                  }
                >
                  {!thumbnailsEnabled
                    ? 'Disabled'
                    : isPaused
                    ? 'Paused'
                    : isGenerating
                    ? 'Generating'
                    : 'Ready'}
                </span>
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-gray-400">Cached:</span>
                <span className="text-white">{status?.ready ?? 0} videos</span>
              </div>
            </div>

            {/* Actions */}
            <div className="py-1">
              {/* Toggle Thumbnails */}
              <button
                onClick={() => {
                  handleToggleThumbnails();
                  setShowMenu(false);
                }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-white/10 transition-colors flex items-center gap-2"
                disabled={isLoading}
              >
                {thumbnailsEnabled ? (
                  <>
                    <svg className="w-4 h-4 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                    </svg>
                    <span>Disable Thumbnails</span>
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <span>Enable Thumbnails</span>
                  </>
                )}
              </button>

              {/* Pause/Resume */}
              {thumbnailsEnabled && (
                <button
                  onClick={() => {
                    handlePauseResume();
                    setShowMenu(false);
                  }}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-white/10 transition-colors flex items-center gap-2"
                  disabled={isLoading}
                >
                  {isPaused ? (
                    <>
                      <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span>Resume Generation</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span>Pause Generation</span>
                    </>
                  )}
                </button>
              )}

              {/* Clear Cache */}
              <button
                onClick={() => {
                  handleClearCache();
                  setShowMenu(false);
                }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-white/10 transition-colors flex items-center gap-2 text-red-400"
                disabled={isLoading}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                <span>Clear All Cache</span>
              </button>
            </div>

            {/* Help text */}
            <div className="px-3 py-2 border-t border-white/10 text-[10px] text-gray-500">
              Disable thumbnails for maximum performance. Use video playback to select clips.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
