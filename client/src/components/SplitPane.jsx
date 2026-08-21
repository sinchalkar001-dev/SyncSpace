import { useCallback, useEffect, useRef, useState } from 'react'
import { useUIStore } from '../store/uiStore.js'
import { Segmented } from './ui/Segmented.jsx'

const STEP = 0.02

const PANES = [
  { value: 'board', label: 'Board', icon: 'pen' },
  { value: 'code', label: 'Code', icon: 'code' },
]

/**
 * Two panes with a draggable divider.
 *
 * Below 720px a split gives each pane roughly 40% of a phone screen, which is
 * unusable for both. There, the panes stack into a single grid cell and a
 * segmented control chooses which one is visible.
 *
 * Both panes stay **mounted** in that mode — the inactive one is hidden with
 * `visibility: hidden`, which keeps it laid out (so Konva and Monaco retain
 * their measured size) while removing it from painting, hit-testing, and the
 * tab order. Unmounting instead would tear down the Yjs binding and Monaco
 * instance on every switch, losing undo history and scroll position.
 *
 * Which pane is hidden is decided in CSS from `data-pane`, so neither child
 * component needs to know this mode exists.
 */
export function SplitPane({ left, right, id }) {
  const ratio = useUIStore((s) => s.splitRatio)
  const setRatio = useUIStore((s) => s.setSplitRatio)
  const frameRef = useRef(null)
  const draggingRef = useRef(false)

  const [pane, setPane] = useState('board')

  useEffect(() => {
    const onMove = (event) => {
      if (!draggingRef.current || !frameRef.current) return
      const rect = frameRef.current.getBoundingClientRect()
      if (rect.width === 0) return
      setRatio((event.clientX - rect.left) / rect.width)
    }
    const onUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.classList.remove('is-resizing')
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [setRatio])

  const startDrag = useCallback((event) => {
    event.preventDefault()
    draggingRef.current = true
    document.body.classList.add('is-resizing')
  }, [])

  const onKeyDown = useCallback(
    (event) => {
      if (event.key === 'ArrowLeft') setRatio(ratio - STEP)
      else if (event.key === 'ArrowRight') setRatio(ratio + STEP)
    },
    [ratio, setRatio]
  )

  const columns = (ratio * 100).toFixed(2) + '% 6px 1fr'

  return (
    <div
      className="split"
      id={id}
      ref={frameRef}
      style={{ gridTemplateColumns: columns }}
      data-pane={pane}
    >
      {/* Hidden by CSS above 720px, so it costs nothing on desktop. */}
      <div className="split__switch">
        <Segmented options={PANES} value={pane} onChange={setPane} label="Visible pane" />
      </div>

      {left}

      <div
        className="split__handle"
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
      />

      {right}
    </div>
  )
}
