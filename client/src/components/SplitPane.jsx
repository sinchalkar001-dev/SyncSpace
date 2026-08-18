import { useCallback, useEffect, useRef } from 'react'
import { useUIStore } from '../store/uiStore.js'

const STEP = 0.02

/** Two panes with a draggable divider. The ratio is local UI state. */
export function SplitPane({ left, right }) {
  const ratio = useUIStore((s) => s.splitRatio)
  const setRatio = useUIStore((s) => s.setSplitRatio)
  const frameRef = useRef(null)
  const draggingRef = useRef(false)

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
    <div className="split" ref={frameRef} style={{ gridTemplateColumns: columns }}>
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
