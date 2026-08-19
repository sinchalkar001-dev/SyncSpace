import { useCallback, useEffect, useRef, useState } from 'react'
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
  select: 'Select and pan',
  pen: 'Freehand',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Text',
  eraser: 'Eraser',
}

const KEYS = { select: 'V', pen: 'P', rect: 'R', ellipse: 'O', text: 'T', eraser: 'E' }
const FILLED = new Set(['select', 'pen', 'text', 'eraser'])

const UNDO_PATH = 'M4 9 H14 A5 5 0 0 1 14 19 H9 M4 9 L8 5 M4 9 L8 13'
const REDO_PATH = 'M20 9 H10 A5 5 0 0 0 10 19 H15 M20 9 L16 5 M20 9 L16 13'
const MORE_PATH =
  'M12 5.5 A1.6 1.6 0 1 1 12 2.3 A1.6 1.6 0 1 1 12 5.5 Z M12 13.6 A1.6 1.6 0 1 1 12 10.4 A1.6 1.6 0 1 1 12 13.6 Z M12 21.7 A1.6 1.6 0 1 1 12 18.5 A1.6 1.6 0 1 1 12 21.7 Z'

function Icon({ path, filled }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d={path}
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Closes a popover on outside click or Escape, returning focus to the trigger. */
function useDismiss(open, close, triggerRef) {
  useEffect(() => {
    if (!open) return undefined

    const onPointerDown = (event) => {
      if (!event.target.closest('[data-popover-root]')) close()
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, close, triggerRef])
}

/**
 * Vertical tool rail floating over the canvas.
 *
 * Everything secondary — colour, width, destructive actions — lives behind a
 * popover so the rail stays a fixed, predictable width instead of overflowing
 * the pane the way a single horizontal bar did.
 */
export function ToolRail({ onClear, onUndo, onRedo, canUndo, canRedo, disabled = false }) {
  const tool = useUIStore((s) => s.tool)
  const setTool = useUIStore((s) => s.setTool)
  const strokeColor = useUIStore((s) => s.strokeColor)
  const setStrokeColor = useUIStore((s) => s.setStrokeColor)
  const strokeWidth = useUIStore((s) => s.strokeWidth)
  const setStrokeWidth = useUIStore((s) => s.setStrokeWidth)

  const [panel, setPanel] = useState(null)
  const styleRef = useRef(null)
  const moreRef = useRef(null)

  const close = useCallback(() => setPanel(null), [])
  useDismiss(panel !== null, close, panel === 'style' ? styleRef : moreRef)

  const toggle = (name) => setPanel((current) => (current === name ? null : name))

  return (
    <div
      className="rail"
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Drawing tools"
      data-popover-root
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
            <Icon path={ICONS[name]} filled={FILLED.has(name)} />
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
          <Icon path={UNDO_PATH} />
        </button>
        <button
          type="button"
          className="rail__btn"
          onClick={onRedo}
          disabled={disabled || !canRedo}
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
        >
          <Icon path={REDO_PATH} />
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
          <Icon path={MORE_PATH} filled />
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
              Clear board
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
