import type { RefObject } from 'react';

type VideoPreviewProps = {
  frameSrc: string | null;
  isLoading: boolean;
  isPlaying: boolean;
  videoSrc: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  onEnded?: () => void;
};

export function VideoPreview({ frameSrc, isLoading, isPlaying, videoSrc, videoRef, onEnded }: VideoPreviewProps) {
  return (
    <div className="relative w-full h-full flex items-center justify-center">
      {/* Video element - always present, visibility toggled */}
      <video
        ref={videoRef as React.RefObject<HTMLVideoElement>}
        src={videoSrc}
        className={`max-w-full max-h-full object-contain ${isPlaying ? 'block' : 'hidden'}`}
        playsInline
        onEnded={onEnded}
      />

      {/* Still frame when paused */}
      {!isPlaying && frameSrc && (
        <img
          src={frameSrc}
          alt="Video frame"
          className="max-w-full max-h-full object-contain"
          draggable={false}
        />
      )}

      {/* Loading indicator */}
      {isLoading && !isPlaying && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        </div>
      )}

      {/* No frame placeholder */}
      {!frameSrc && !isLoading && !isPlaying && (
        <div className="text-gray-500 text-sm">No preview available</div>
      )}
    </div>
  );
}
