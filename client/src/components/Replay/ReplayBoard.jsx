import { useEffect, useMemo, useState } from 'react'
import { Layer, Stage } from 'react-konva'
import { ShapeNode } from '../Whiteboard/ShapeNode.jsx'
import { useElementSize } from '../../hooks/useElementSize.js'
import { unionBounds } from '../../lib/hitTest.js'
import { covers, fitTo, union } from '../../lib/replay.js'

const noop = () => {}

/**
 * The whiteboard as it stood at one point in the history.
 *
 * Painting is `ShapeNode`, the same component the live board uses, so a shape
 * looks in the replay exactly as it looked when it was drawn. Everything else
 * about the live board — tools, selection, drafts, cursors, the Yjs bindings —
 * is absent by construction rather than disabled: there is nothing here to
 * edit, only a list of shapes.
 *
 * Kept in its own file so the viewer can be tested. Konva paints to a canvas
 * that jsdom does not implement, and mocking one small component is honest in
 * a way that mocking the whole viewer would not be.
 */
export function ReplayBoard({ shapes, label = 'Whiteboard at this point in the history' }) {
  const [containerRef, size] = useElementSize()
  const [box, setBox] = useState(null)

  /**
   * The camera is fitted to everything the room has ever held rather than to
   * the frame on screen. Refitting per frame would rescale and recentre the
   * drawing on every step, which reads as the board moving rather than as work
   * appearing. It only ever grows, so scrubbing back to a state that reached
   * further than the present still fits inside the pane.
   */
  useEffect(() => {
    const bounds = unionBounds(shapes)
    if (!bounds) return
    setBox((seen) => (covers(seen, bounds) ? seen : union(seen, bounds)))
  }, [shapes])

  const view = useMemo(() => fitTo(box, size), [box, size])

  return (
    <div className="replay__board" ref={containerRef} role="img" aria-label={label}>
      {size.width > 0 && size.height > 0 && (
        <Stage
          width={size.width}
          height={size.height}
          scaleX={view.scale}
          scaleY={view.scale}
          x={view.x}
          y={view.y}
          listening={false}
        >
          <Layer>
            {shapes.map((shape) => (
              <ShapeNode
                key={shape.id}
                shape={shape}
                draggable={false}
                isSelected={false}
                onPointerDown={noop}
                onDragEnd={noop}
              />
            ))}
          </Layer>
        </Stage>
      )}

      {shapes.length === 0 && <p className="replay__blank muted">Nothing had been drawn yet.</p>}
    </div>
  )
}
