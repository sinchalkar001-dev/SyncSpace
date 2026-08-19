import { useUIStore } from '../../store/uiStore.js'

/** Floating zoom pill, anchored to the bottom-left of the canvas. */
export function CanvasControls() {
  const scale = useUIStore((s) => s.viewport.scale)
  const zoomBy = useUIStore((s) => s.zoomBy)
  const resetViewport = useUIStore((s) => s.resetViewport)

  return (
    <div className="zoombar" role="group" aria-label="Zoom">
      <button
        type="button"
        className="zoombar__btn"
        onClick={() => zoomBy(1 / 1.2)}
        title="Zoom out"
        aria-label="Zoom out"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3 8 H13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      <button
        type="button"
        className="zoombar__value"
        onClick={resetViewport}
        title="Reset zoom and pan"
      >
        {Math.round(scale * 100)}%
      </button>

      <button
        type="button"
        className="zoombar__btn"
        onClick={() => zoomBy(1.2)}
        title="Zoom in"
        aria-label="Zoom in"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M8 3 V13 M3 8 H13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
