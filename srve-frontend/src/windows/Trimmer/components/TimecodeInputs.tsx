import { useCallback, useState } from 'react';

type TimecodeInputsProps = {
  inPoint: number;
  outPoint: number;
  duration: number;
  onInPointChange: (ms: number) => void;
  onOutPointChange: (ms: number) => void;
  formatTime: (ms: number) => string;
};

function parseTimecode(str: string): number | null {
  const parts = str.split(':').map((p) => p.trim());
  if (parts.length === 3) {
    const [min, sec, ms] = parts.map(Number);
    if (!isNaN(min) && !isNaN(sec) && !isNaN(ms)) {
      return min * 60000 + sec * 1000 + ms;
    }
  }
  if (parts.length === 2) {
    const [sec, ms] = parts.map(Number);
    if (!isNaN(sec) && !isNaN(ms)) {
      return sec * 1000 + ms;
    }
  }
  const num = Number(str);
  if (!isNaN(num)) {
    return num;
  }
  return null;
}

export function TimecodeInputs({
  inPoint,
  outPoint,
  duration,
  onInPointChange,
  onOutPointChange,
  formatTime,
}: TimecodeInputsProps) {
  const [editingIn, setEditingIn] = useState(false);
  const [editingOut, setEditingOut] = useState(false);
  const [inValue, setInValue] = useState('');
  const [outValue, setOutValue] = useState('');

  const handleInFocus = useCallback(() => {
    setEditingIn(true);
    setInValue(formatTime(inPoint));
  }, [inPoint, formatTime]);

  const handleInBlur = useCallback(() => {
    setEditingIn(false);
    const parsed = parseTimecode(inValue);
    if (parsed !== null) {
      const clamped = Math.max(0, Math.min(outPoint - 1, parsed));
      onInPointChange(clamped);
    }
  }, [inValue, outPoint, onInPointChange]);

  const handleInKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        (e.target as HTMLInputElement).blur();
      } else if (e.key === 'Escape') {
        setEditingIn(false);
        setInValue(formatTime(inPoint));
      }
    },
    [inPoint, formatTime],
  );

  const handleOutFocus = useCallback(() => {
    setEditingOut(true);
    setOutValue(formatTime(outPoint));
  }, [outPoint, formatTime]);

  const handleOutBlur = useCallback(() => {
    setEditingOut(false);
    const parsed = parseTimecode(outValue);
    if (parsed !== null) {
      const clamped = Math.max(inPoint + 1, Math.min(duration, parsed));
      onOutPointChange(clamped);
    }
  }, [outValue, inPoint, duration, onOutPointChange]);

  const handleOutKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        (e.target as HTMLInputElement).blur();
      } else if (e.key === 'Escape') {
        setEditingOut(false);
        setOutValue(formatTime(outPoint));
      }
    },
    [outPoint, formatTime],
  );

  const selectionDuration = outPoint - inPoint;

  return (
    <div className="flex items-center gap-4 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-gray-400">In:</span>
        <input
          type="text"
          value={editingIn ? inValue : formatTime(inPoint)}
          onChange={(e) => setInValue(e.target.value)}
          onFocus={handleInFocus}
          onBlur={handleInBlur}
          onKeyDown={handleInKeyDown}
          className="w-24 px-2 py-1 bg-black/30 border border-white/10 rounded font-mono text-xs text-center focus:outline-none focus:border-blue-500"
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-gray-400">Out:</span>
        <input
          type="text"
          value={editingOut ? outValue : formatTime(outPoint)}
          onChange={(e) => setOutValue(e.target.value)}
          onFocus={handleOutFocus}
          onBlur={handleOutBlur}
          onKeyDown={handleOutKeyDown}
          className="w-24 px-2 py-1 bg-black/30 border border-white/10 rounded font-mono text-xs text-center focus:outline-none focus:border-blue-500"
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-gray-400">Duration:</span>
        <span className="font-mono text-xs">{formatTime(selectionDuration)}</span>
      </div>

      <div className="flex items-center gap-2 text-gray-500">
        <span>Total:</span>
        <span className="font-mono text-xs">{formatTime(duration)}</span>
      </div>
    </div>
  );
}
