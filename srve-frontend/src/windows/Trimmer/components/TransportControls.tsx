type TransportControlsProps = {
  isPlaying: boolean;
  currentTime: number;
  volume: number;
  onTogglePlay: () => void;
  onPrevFrame: () => void;
  onNextFrame: () => void;
  onRewind: () => void;
  onFastForward: () => void;
  onJumpToIn: () => void;
  onJumpToOut: () => void;
  onVolumeChange: (volume: number) => void;
  formatTime: (ms: number) => string;
};

export function TransportControls({
  isPlaying,
  currentTime,
  volume,
  onTogglePlay,
  onPrevFrame,
  onNextFrame,
  onRewind,
  onFastForward,
  onJumpToIn,
  onJumpToOut,
  onVolumeChange,
  formatTime,
}: TransportControlsProps) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-2 bg-srve-panel border-y border-white/10">
      {/* Jump to In */}
      <button
        onClick={onJumpToIn}
        className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
        title="Jump to In (Home)"
      >
        <span className="text-sm">|◀</span>
      </button>

      {/* Previous Frame */}
      <button
        onClick={onPrevFrame}
        className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
        title="Previous Frame (←)"
      >
        <span className="text-sm">◀</span>
      </button>

      {/* Rewind */}
      <button
        onClick={onRewind}
        className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
        title="Rewind 1s (Shift+←)"
      >
        <span className="text-sm">◀◀</span>
      </button>

      {/* Play/Pause */}
      <button
        onClick={onTogglePlay}
        className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-colors"
        title="Play/Pause (Space)"
      >
        <span className="text-lg">{isPlaying ? '❚❚' : '▶'}</span>
      </button>

      {/* Fast Forward */}
      <button
        onClick={onFastForward}
        className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
        title="Forward 1s (Shift+→)"
      >
        <span className="text-sm">▶▶</span>
      </button>

      {/* Next Frame */}
      <button
        onClick={onNextFrame}
        className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
        title="Next Frame (→)"
      >
        <span className="text-sm">▶</span>
      </button>

      {/* Jump to Out */}
      <button
        onClick={onJumpToOut}
        className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
        title="Jump to Out (End)"
      >
        <span className="text-sm">▶|</span>
      </button>

      {/* Spacer */}
      <div className="w-4" />

      {/* Current Timecode */}
      <div className="min-w-[100px] px-3 py-1 bg-black/30 rounded font-mono text-sm text-center">
        {formatTime(currentTime)}
      </div>

      {/* Volume */}
      <div className="flex items-center gap-2 ml-4">
        <span className="text-sm">🔊</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          onChange={(e) => onVolumeChange(Number(e.target.value))}
          className="w-20 h-1 accent-blue-500"
        />
      </div>
    </div>
  );
}
