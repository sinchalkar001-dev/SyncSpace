import { useCallback, useEffect, useRef, useState } from 'react'
import { Layer, Stage } from 'react-konva'
import { nanoid } from 'nanoid'
import { clearShapes, pushShape, removeShape, updateShape } from '../../lib/collab.js'
import { useShapes } from '../../hooks/useShapes.js'
import { useElementSize } from '../../hooks/useElementSize.js'
import { useCursorBroadcast } from '../../hooks/useAwareness.js'
import { MAX_SCALE, MIN_SCALE, useUIStore } from '../../store/uiStore.js'
import { ShapeNode } from './ShapeNode.jsx'
import { RemoteCursors } from './RemoteCursors.jsx'
import { Toolbar } from './Toolbar.jsx'

const MIN_POINT_DISTANCE = 2
const SHORTCUTS = { v: 'select', p: 'pen', r: 'rect', o: 'ellipse', t: 'text', e: 'eraser' }

/** Converts a screen pointer position into document coordinates. */
function worldPointer(stage) {
  const pointer = stage.getPointerPosition()
  if (!pointer) return null
  return stage.getAbsoluteTransform().copy().invert().point(pointer)
}

export function Whiteboard({ shapes, provider, peers, user }) {
  const [containerRef, size] = useElementSize()
  const [draft, setDraft] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const drawingRef = useRef(false)

  const tool = useUIStore((s) => s.tool)
  const setTool = useUIStore((s) => s.setTool)
  const strokeColor = useUIStore((s) => s.strokeColor)
  const strokeWidth = useUIStore((s) => s.strokeWidth)
  const fontSize = useUIStore((s) => s.fontSize)
  const viewport = useUIStore((s) => s.viewport)
  const setViewport = useUIStore((s) => s.setViewport)

  const list = useShapes(shapes)
  const { publish: publishCursor, clear: clearCursor } = useCursorBroadcast(provider)

  const isDrawingTool = tool !== 'select' && tool !== 'eraser'

  const commitDraft = useCallback(() => {
    drawingRef.current = false
    setDraft((current) => {
      if (!current || !shapes) return null
      const base = {
        id: nanoid(8),
        stroke: current.stroke,
        strokeWidth: current.strokeWidth,
        author: user.id,
        x: current.x,
        y: current.y,
      }

      if (current.type === 'line' && current.points.length >= 4) {
        pushShape(shapes, { ...base, type: 'line', x: 0, y: 0, points: current.points })
      } else if (current.type === 'rect' && current.width > 2 && current.height > 2) {
        pushShape(shapes, { ...base, type: 'rect', width: current.width, height: current.height })
      } else if (current.type === 'ellipse' && current.radiusX > 2 && current.radiusY > 2) {
        pushShape(shapes, {
          ...base,
          type: 'ellipse',
          radiusX: current.radiusX,
          radiusY: current.radiusY,
        })
      }
      return null
    })
  }, [shapes, user.id])

  const handlePointerDown = useCallback(
    (event) => {
      const stage = event.target.getStage()
      const point = worldPointer(stage)
      if (!point) return

      if (tool === 'select') {
        if (event.target === stage) setSelectedId(null)
        return
      }
      if (tool === 'eraser') return

      if (tool === 'text') {
        const value = window.prompt('Text to place on the board')
        if (value && value.trim()) {
          pushShape(shapes, {
            id: nanoid(8),
            type: 'text',
            x: point.x,
            y: point.y,
            text: value.trim(),
            fontSize,
            stroke: strokeColor,
            strokeWidth: 0,
            author: user.id,
          })
        }
        setTool('select')
        return
      }

      drawingRef.current = true
      const common = { stroke: strokeColor, strokeWidth, origin: point }

      if (tool === 'pen') {
        setDraft({ ...common, type: 'line', x: 0, y: 0, points: [point.x, point.y] })
      } else if (tool === 'rect') {
        setDraft({ ...common, type: 'rect', x: point.x, y: point.y, width: 0, height: 0 })
      } else if (tool === 'ellipse') {
        setDraft({ ...common, type: 'ellipse', x: point.x, y: point.y, radiusX: 0, radiusY: 0 })
      }
    },
    [tool, shapes, strokeColor, strokeWidth, fontSize, setTool, user.id]
  )

  const handlePointerMove = useCallback(
    (event) => {
      const stage = event.target.getStage()
      const point = worldPointer(stage)
      if (!point) return

      publishCursor({ x: point.x, y: point.y })
      if (!drawingRef.current) return

      setDraft((current) => {
        if (!current) return current

        if (current.type === 'line') {
          const lastX = current.points[current.points.length - 2]
          const lastY = current.points[current.points.length - 1]
          if (Math.hypot(point.x - lastX, point.y - lastY) < MIN_POINT_DISTANCE) return current
          return { ...current, points: [...current.points, point.x, point.y] }
        }

        const origin = current.origin
        if (current.type === 'rect') {
          return {
            ...current,
            x: Math.min(origin.x, point.x),
            y: Math.min(origin.y, point.y),
            width: Math.abs(point.x - origin.x),
            height: Math.abs(point.y - origin.y),
          }
        }
        return {
          ...current,
          x: (origin.x + point.x) / 2,
          y: (origin.y + point.y) / 2,
          radiusX: Math.abs(point.x - origin.x) / 2,
          radiusY: Math.abs(point.y - origin.y) / 2,
        }
      })
    },
    [publishCursor]
  )

  const handleShapePointerDown = useCallback(
    (event, shape) => {
      if (tool === 'eraser') {
        event.cancelBubble = true
        removeShape(shapes, shape.id)
        if (selectedId === shape.id) setSelectedId(null)
        return
      }
      if (tool === 'select') {
        event.cancelBubble = true
        setSelectedId(shape.id)
      }
    },
    [tool, shapes, selectedId]
  )

  const handleShapeDragEnd = useCallback((id, patch) => updateShape(shapes, id, patch), [shapes])

  const handleWheel = useCallback(
    (event) => {
      event.evt.preventDefault()
      const stage = event.target.getStage()
      const pointer = stage.getPointerPosition()
      if (!pointer) return

      const oldScale = viewport.scale
      const anchor = {
        x: (pointer.x - viewport.x) / oldScale,
        y: (pointer.y - viewport.y) / oldScale,
      }
      const factor = event.evt.deltaY > 0 ? 1 / 1.08 : 1.08
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * factor))

      setViewport({
        scale,
        x: pointer.x - anchor.x * scale,
        y: pointer.y - anchor.y * scale,
      })
    },
    [viewport, setViewport]
  )

  const handleStageDragEnd = useCallback(
    (event) => {
      if (event.target !== event.target.getStage()) return
      setViewport({ ...viewport, x: event.target.x(), y: event.target.y() })
    },
    [viewport, setViewport]
  )

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape') {
        setSelectedId(null)
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault()
        removeShape(shapes, selectedId)
        setSelectedId(null)
        return
      }
      const next = SHORTCUTS[event.key.toLowerCase()]
      if (next && !event.metaKey && !event.ctrlKey) setTool(next)
    },
    [selectedId, shapes, setTool]
  )

  // A pointer released outside the canvas must still close the stroke.
  useEffect(() => {
    const onUp = () => {
      if (drawingRef.current) commitDraft()
    }
    window.addEventListener('pointerup', onUp)
    return () => window.removeEventListener('pointerup', onUp)
  }, [commitDraft])

  const handleClear = useCallback(() => {
    if (window.confirm('Clear the board for everyone in this room?')) {
      clearShapes(shapes)
      setSelectedId(null)
    }
  }, [shapes])

  const boardClass = isDrawingTool ? 'board board--draw' : 'board'

  return (
    <section className="pane pane--board">
      <Toolbar onClear={handleClear} />
      <div className={boardClass} ref={containerRef} tabIndex={0} onKeyDown={handleKeyDown}>
        {size.width > 0 && size.height > 0 && (
          <Stage
            width={size.width}
            height={size.height}
            scaleX={viewport.scale}
            scaleY={viewport.scale}
            x={viewport.x}
            y={viewport.y}
            draggable={tool === 'select'}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={commitDraft}
            onPointerLeave={clearCursor}
            onDragEnd={handleStageDragEnd}
            onWheel={handleWheel}
          >
            <Layer>
              {list.map((shape) => (
                <ShapeNode
                  key={shape.id}
                  shape={shape}
                  draggable={tool === 'select'}
                  isSelected={selectedId === shape.id}
                  onPointerDown={handleShapePointerDown}
                  onDragEnd={handleShapeDragEnd}
                />
              ))}
              {draft && (
                <ShapeNode
                  shape={{ ...draft, id: '__draft__' }}
                  draggable={false}
                  isSelected={false}
                  onPointerDown={() => {}}
                  onDragEnd={() => {}}
                />
              )}
            </Layer>
            <Layer listening={false}>
              <RemoteCursors peers={peers} scale={viewport.scale} />
            </Layer>
          </Stage>
        )}
      </div>
    </section>
  )
}
