type ZoomControlsProps = {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onFitAll: () => void;
  onFitSelection: () => void;
};

export function ZoomControls({
  zoom,
  onZoomChange,
  onFitAll,
  onFitSelection,
}: ZoomControlsProps) {
  const handleZoomIn = () => {
    onZoomChange(Math.min(50, zoom * 1.5));
  };

  const handleZoomOut = () => {
    onZoomChange(Math.max(1, zoom / 1.5));
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleZoomOut}
        className="w-7 h-7 flex items-center justify-center rounded bg-white/10 hover:bg-white/20 transition-colors text-sm"
        title="Zoom Out"
      >
        −
      </button>

      <input
        type="range"
        min="1"
        max="50"
        step="0.5"
        value={zoom}
        onChange={(e) => onZoomChange(Number(e.target.value))}
        className="w-24 h-1 accent-blue-500"
      />

      <button
        onClick={handleZoomIn}
        className="w-7 h-7 flex items-center justify-center rounded bg-white/10 hover:bg-white/20 transition-colors text-sm"
        title="Zoom In"
      >
        +
      </button>

      <span className="text-xs text-gray-400 w-12 text-center">{Math.round(zoom * 100)}%</span>

      <div className="w-px h-5 bg-white/20 mx-1" />

      <button
        onClick={onFitAll}
        className="px-2 py-1 text-xs bg-white/10 hover:bg-white/20 rounded transition-colors"
        title="Fit entire video"
      >
        Fit
      </button>

      <button
        onClick={onFitSelection}
        className="px-2 py-1 text-xs bg-white/10 hover:bg-white/20 rounded transition-colors"
        title="Fit selection"
      >
        Selection
      </button>
    </div>
  );
}
