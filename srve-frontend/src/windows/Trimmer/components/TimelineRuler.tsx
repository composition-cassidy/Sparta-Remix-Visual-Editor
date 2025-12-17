import { useCallback, useRef } from 'react';

type TimelineRulerProps = {
  duration: number;
  zoom: number;
  scrollOffset: number;
  onSeek: (ms: number) => void;
};

function formatRulerTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
  return `${seconds}s`;
}

export function TimelineRuler({ duration, zoom, scrollOffset, onSeek }: TimelineRulerProps) {
  const rulerRef = useRef<HTMLDivElement>(null);

  const visibleDuration = duration / zoom;
  const startMs = scrollOffset * duration;

  const getTickInterval = () => {
    const targetTicks = 10;
    const msPerTick = visibleDuration / targetTicks;

    const intervals = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
    for (const interval of intervals) {
      if (interval >= msPerTick) {
        return interval;
      }
    }
    return 60000;
  };

  const tickInterval = getTickInterval();
  const firstTick = Math.ceil(startMs / tickInterval) * tickInterval;
  const ticks: number[] = [];

  for (let t = firstTick; t <= startMs + visibleDuration; t += tickInterval) {
    ticks.push(t);
  }

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!rulerRef.current) return;
      const rect = rulerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = x / rect.width;
      const ms = startMs + pct * visibleDuration;
      onSeek(Math.max(0, Math.min(duration, ms)));
    },
    [startMs, visibleDuration, duration, onSeek],
  );

  return (
    <div
      ref={rulerRef}
      className="h-6 bg-srve-panel border-b border-white/10 relative cursor-pointer"
      onClick={handleClick}
    >
      {ticks.map((t) => {
        const pct = ((t - startMs) / visibleDuration) * 100;
        const isMajor = t % (tickInterval * 5) === 0 || tickInterval >= 5000;
        return (
          <div
            key={t}
            className="absolute top-0 flex flex-col items-center"
            style={{ left: `${pct}%`, transform: 'translateX(-50%)' }}
          >
            <div
              className={`w-px ${isMajor ? 'h-4 bg-white/50' : 'h-2 bg-white/30'}`}
              style={{ marginTop: isMajor ? 0 : 8 }}
            />
            {isMajor && (
              <span className="text-[9px] text-gray-400 mt-0.5">{formatRulerTime(t)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
