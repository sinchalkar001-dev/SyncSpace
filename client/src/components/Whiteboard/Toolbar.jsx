import { STROKE_COLORS, TOOLS, useUIStore } from '../../store/uiStore.js'

const ICONS = {
  select: 'M4 3 L18 11 L11.5 12.4 L14.4 18 L12 19.2 L9.2 13.6 L4 17 Z',
  pen: 'M3 17.2 L14.1 6.1 L16.9 8.9 L5.8 20 L2 21 Z M15.5 4.7 L17.3 2.9 A1.6 1.6 0 0 1 19.6 5.2 L17.9 7 Z',
  rect: 'M3 5 H21 V19 H3 Z',
  ellipse: 'M12 5 A9 7 0 1 1 12 19 A9 7 0 1 1 12 5 Z',
  text: 'M4 4 H20 V8 H18 V6 H13 V18 H15.5 V20 H8.5 V18 H11 V6 H6 V8 H4 Z',
  eraser: 'M8 20 L3 15 A2 2 0 0 1 3 12 L12 3 A2 2 0 0 1 15 3 L21 9 A2 2 0 0 1 21 12 L13 20 Z',
}

const LABELS = {
  select: 'Select / pan (V)',
  pen: 'Freehand (P)',
  rect: 'Rectangle (R)',
  ellipse: 'Ellipse (O)',
  text: 'Text (T)',
  eraser: 'Eraser (E)',
}

const FILLED = new Set(['select', 'pen', 'text', 'eraser'])

export function Toolbar({ onClear }) {
  const tool = useUIStore((s) => s.tool)
  const setTool = useUIStore((s) => s.setTool)
  const strokeColor = useUIStore((s) => s.strokeColor)
  const setStrokeColor = useUIStore((s) => s.setStrokeColor)
  const strokeWidth = useUIStore((s) => s.strokeWidth)
  const setStrokeWidth = useUIStore((s) => s.setStrokeWidth)
  const scale = useUIStore((s) => s.viewport.scale)
  const zoomBy = useUIStore((s) => s.zoomBy)
  const resetViewport = useUIStore((s) => s.resetViewport)

  return (
    <div className="toolbar">
      <div className="toolbar__group">
        {TOOLS.map((name) => (
          <button
            key={name}
            type="button"
            className={`tool-btn ${tool === name ? 'is-active' : ''}`}
            onClick={() => setTool(name)}
            title={LABELS[name]}
            aria-label={LABELS[name]}
            aria-pressed={tool === name}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
              <path
                d={ICONS[name]}
                fill={FILLED.has(name) ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth={FILLED.has(name) ? 0 : 1.8}
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ))}
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group">
        {STROKE_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`swatch ${strokeColor === color ? 'is-active' : ''}`}
            style={{ background: color }}
            onClick={() => setStrokeColor(color)}
            title={color}
            aria-label={`Stroke colour ${color}`}
            aria-pressed={strokeColor === color}
          />
        ))}
      </div>

      <div className="toolbar__divider" />

      <label className="toolbar__slider" title="Stroke width">
        <span className="toolbar__hint">Width</span>
        <input
          type="range"
          min="1"
          max="18"
          value={strokeWidth}
          onChange={(event) => setStrokeWidth(Number(event.target.value))}
        />
        <span className="toolbar__value">{strokeWidth}</span>
      </label>

      <div className="toolbar__divider" />

      <div className="toolbar__group">
        <button type="button" className="tool-btn" onClick={() => zoomBy(1 / 1.2)} title="Zoom out">
          &minus;
        </button>
        <button
          type="button"
          className="tool-btn tool-btn--wide"
          onClick={resetViewport}
          title="Reset zoom and pan"
        >
          {Math.round(scale * 100)}%
        </button>
        <button type="button" className="tool-btn" onClick={() => zoomBy(1.2)} title="Zoom in">
          +
        </button>
      </div>

      <button type="button" className="btn btn--danger toolbar__clear" onClick={onClear}>
        Clear board
      </button>
    </div>
  )
}
