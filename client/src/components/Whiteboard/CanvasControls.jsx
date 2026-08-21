import { useUIStore } from '../../store/uiStore.js'
import { Icon } from '../ui/Icon.jsx'

/**
 * Floating zoom pill, anchored to the bottom-left of the canvas.
 *
 * Geometry note: must stay inside the bottom 130px of `.board`, which the
 * eraser end-to-end tests clip out of their screenshots. See layout.css.
 */
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
        <Icon name="minus" size={14} />
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
        <Icon name="plus" size={14} />
      </button>
    </div>
  )
}
