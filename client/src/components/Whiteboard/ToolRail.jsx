import { useCallback, useRef, useState } from 'react'
import { STROKE_COLORS, TOOLS, useUIStore } from '../../store/uiStore.js'
import { useDismissable } from '../../hooks/useDismissable.js'
import { Icon } from '../ui/Icon.jsx'

const LABELS = {
  select: 'Select and pan',
  pen: 'Freehand',
  segment: 'Straight line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  diamond: 'Diamond',
  ellipse: 'Ellipse',
  text: 'Text',
  eraser: 'Eraser',
}

const KEYS = {
  select: 'V',
  pen: 'P',
  segment: 'L',
  arrow: 'A',
  rect: 'R',
  diamond: 'D',
  ellipse: 'O',
  text: 'T',
  eraser: 'E',
}

/**
 * Vertical tool rail floating over the canvas.
 *
 * Everything secondary — colour, width, destructive actions — lives behind a
 * popover so the rail stays a fixed, predictable width instead of overflowing
 * the pane the way a single horizontal bar did.
 *
 * Geometry note: the rail must stay inside the left 140px of `.board`, which
 * the eraser end-to-end tests clip out of their screenshots. See layout.css.
 */
export function ToolRail({ onClear, onUndo, onRedo, canUndo, canRedo, disabled = false }) {
  const tool = useUIStore((s) => s.tool)
  const setTool = useUIStore((s) => s.setTool)
  const strokeColor = useUIStore((s) => s.strokeColor)
  const setStrokeColor = useUIStore((s) => s.setStrokeColor)
  const strokeWidth = useUIStore((s) => s.strokeWidth)
  const setStrokeWidth = useUIStore((s) => s.setStrokeWidth)

  const [panel, setPanel] = useState(null)
  const railRef = useRef(null)
  const styleRef = useRef(null)
  const moreRef = useRef(null)

  const close = useCallback(() => setPanel(null), [])

  // Escape is captured here: the board also handles Escape to clear its
  // selection, and closing a popover must not do both at once.
  useDismissable(panel !== null, close, {
    containerRef: railRef,
    triggerRef: panel === 'style' ? styleRef : moreRef,
    captureEscape: true,
  })

  const toggle = (name) => setPanel((current) => (current === name ? null : name))

  return (
    <div
      className="rail"
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Drawing tools"
      ref={railRef}
    >
      <div className="rail__group">
        {TOOLS.map((name) => (
          <button
            key={name}
            type="button"
            className={'rail__btn' + (tool === name ? ' is-active' : '')}
            onClick={() => setTool(name)}
            title={LABELS[name] + ' (' + KEYS[name] + ')'}
            aria-label={LABELS[name]}
            aria-keyshortcuts={KEYS[name]}
            aria-pressed={tool === name}
            disabled={disabled}
          >
            <Icon name={name} size={18} />
          </button>
        ))}
      </div>

      <div className="rail__sep" />

      <div className="rail__anchor">
        <button
          type="button"
          className={'rail__btn' + (panel === 'style' ? ' is-open' : '')}
          onClick={() => toggle('style')}
          aria-expanded={panel === 'style'}
          aria-haspopup="dialog"
          title="Colour and width"
          aria-label="Colour and width"
          disabled={disabled}
          ref={styleRef}
        >
          <span className="rail__chip" style={{ background: strokeColor }} />
        </button>

        {panel === 'style' && (
          <div className="popover popover--style" role="dialog" aria-label="Stroke style">
            <p className="popover__label">Colour</p>
            <div className="swatches" role="group" aria-label="Stroke colour">
              {STROKE_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={'swatch' + (strokeColor === color ? ' is-active' : '')}
                  style={{ background: color }}
                  onClick={() => setStrokeColor(color)}
                  aria-label={'Stroke colour ' + color}
                  aria-pressed={strokeColor === color}
                />
              ))}
            </div>

            <p className="popover__label">Width</p>
            <div className="widthrow">
              <input
                type="range"
                min="1"
                max="18"
                value={strokeWidth}
                onChange={(event) => setStrokeWidth(Number(event.target.value))}
                aria-label="Stroke width"
              />
              <span className="widthrow__well" aria-hidden="true">
                <span
                  className="widthrow__preview"
                  style={{
                    width: strokeWidth + 'px',
                    height: strokeWidth + 'px',
                    background: strokeColor,
                  }}
                />
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="rail__sep" />

      <div className="rail__group">
        <button
          type="button"
          className="rail__btn"
          onClick={onUndo}
          disabled={disabled || !canUndo}
          title="Undo your last change (Ctrl+Z)"
          aria-label="Undo"
        >
          <Icon name="undo" size={18} />
        </button>
        <button
          type="button"
          className="rail__btn"
          onClick={onRedo}
          disabled={disabled || !canRedo}
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
        >
          <Icon name="redo" size={18} />
        </button>
      </div>

      <div className="rail__sep" />

      <div className="rail__anchor">
        <button
          type="button"
          className={'rail__btn' + (panel === 'more' ? ' is-open' : '')}
          onClick={() => toggle('more')}
          aria-expanded={panel === 'more'}
          aria-haspopup="menu"
          title="More actions"
          aria-label="More actions"
          disabled={disabled}
          ref={moreRef}
        >
          <Icon name="more" size={18} />
        </button>

        {panel === 'more' && (
          <div className="popover popover--menu" role="menu">
            <button
              type="button"
              className="popover__item popover__item--danger"
              role="menuitem"
              onClick={() => {
                close()
                onClear()
              }}
            >
              <Icon name="trash" size={14} />
              Clear board
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
