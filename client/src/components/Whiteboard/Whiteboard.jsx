import { useCallback, useEffect, useRef, useState } from 'react'
import { Layer, Stage } from 'react-konva'
import { nanoid } from 'nanoid'
import { clearShapes, pushShape, removeShape, updateShape } from '../../lib/collab.js'
import { shapesHitBy } from '../../lib/hitTest.js'
import { useShapes } from '../../hooks/useShapes.js'
import { useElementSize } from '../../hooks/useElementSize.js'
import { useCursorBroadcast } from '../../hooks/useAwareness.js'
import { useUndo } from '../../hooks/useUndo.js'
import { MAX_SCALE, MIN_SCALE, useUIStore } from '../../store/uiStore.js'
import { ConfirmDialog } from '../ui/Modal.jsx'
import { formatWhen } from '../../lib/rooms.js'
import { ShapeNode } from './ShapeNode.jsx'
import { RemoteCursors } from './RemoteCursors.jsx'
import { ToolRail } from './ToolRail.jsx'
import { CanvasControls } from './CanvasControls.jsx'
import { TextComposer } from './TextComposer.jsx'

const MIN_POINT_DISTANCE = 2

// The eraser reaches this far, in screen pixels. A bare point test makes thin
// strokes almost impossible to hit while dragging, which reads as "the eraser
// does not work". Screen units on purpose, so the reach feels the same at any
// zoom level.
const ERASER_RADIUS = 14

const SHORTCUTS = {
  v: 'select',
  p: 'pen',
  l: 'segment',
  a: 'arrow',
  r: 'rect',
  d: 'diamond',
  o: 'ellipse',
  t: 'text',
  e: 'eraser',
}

// Shapes whose geometry is a dragged box.
const BOXY = new Set(['rect', 'diamond'])
// Shapes that are a single straight run between two points.
const STRAIGHT = new Set(['segment', 'arrow'])

/** Snaps a drag to the nearest 45 degrees, for Shift-constrained lines. */
function constrain(origin, point) {
  const dx = point.x - origin.x
  const dy = point.y - origin.y
  const step = Math.PI / 4
  const angle = Math.round(Math.atan2(dy, dx) / step) * step
  const length = Math.hypot(dx, dy)
  return { x: origin.x + Math.cos(angle) * length, y: origin.y + Math.sin(angle) * length }
}

/** Converts a screen pointer position into document coordinates. */
function worldPointer(stage) {
  const pointer = stage.getPointerPosition()
  if (!pointer) return null
  return stage.getAbsoluteTransform().copy().invert().point(pointer)
}

export function Whiteboard({ shapes, provider, undoManager, peers, user, readOnly = false }) {
  const [containerRef, size] = useElementSize()
  const [draft, setDraftState] = useState(null)
  const [textDraft, setTextDraftState] = useState(null)
  // Mirrors of the two drafts. Committing a shape is a side effect, and side
  // effects must not live inside a setState updater: React invokes updaters
  // twice under StrictMode, which committed every shape twice - two identical
  // shapes stacked exactly on top of each other.
  const draftRef = useRef(null)
  const textDraftRef = useRef(null)
  const [selectedId, setSelectedId] = useState(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const drawingRef = useRef(false)
  const erasingRef = useRef(false)
  // Who drew the shape under the pointer, anchored where the pointer entered.
  const [hovered, setHovered] = useState(null)

  const setDraft = useCallback((next) => {
    const value = typeof next === 'function' ? next(draftRef.current) : next
    draftRef.current = value
    setDraftState(value)
  }, [])

  const setTextDraft = useCallback((next) => {
    const value = typeof next === 'function' ? next(textDraftRef.current) : next
    textDraftRef.current = value
    setTextDraftState(value)
  }, [])

  const tool = useUIStore((s) => s.tool)
  const setTool = useUIStore((s) => s.setTool)
  const strokeColor = useUIStore((s) => s.strokeColor)
  const strokeWidth = useUIStore((s) => s.strokeWidth)
  const fontSize = useUIStore((s) => s.fontSize)
  const viewport = useUIStore((s) => s.viewport)
  const setViewport = useUIStore((s) => s.setViewport)

  const list = useShapes(shapes)
  const { publish: publishCursor, clear: clearCursor } = useCursorBroadcast(provider)
  const { canUndo, canRedo, undo, redo } = useUndo(undoManager)

  const isDrawingTool = tool !== 'select' && tool !== 'eraser'

  const commitDraft = useCallback(() => {
    drawingRef.current = false
    erasingRef.current = false

    const current = draftRef.current
    setDraft(null)
    if (!current || !shapes) return

    const base = {
      id: nanoid(8),
      stroke: current.stroke,
      strokeWidth: current.strokeWidth,
      author: user.id,
      authorName: user.name,
      authorColor: user.color,
      createdAt: Date.now(),
      x: current.x,
      y: current.y,
    }

    if (current.type === 'line' && current.points.length >= 4) {
      pushShape(shapes, { ...base, type: 'line', x: 0, y: 0, points: current.points })
    } else if (current.type === 'rect' && current.width > 2 && current.height > 2) {
      pushShape(shapes, { ...base, type: 'rect', width: current.width, height: current.height })
    } else if (STRAIGHT.has(current.type) && current.points.length === 4) {
      const [x1, y1, x2, y2] = current.points
      if (Math.hypot(x2 - x1, y2 - y1) < 4) return
      pushShape(shapes, { ...base, type: current.type, x: 0, y: 0, points: current.points })
    } else if (current.type === 'diamond' && current.width > 2 && current.height > 2) {
      pushShape(shapes, { ...base, type: 'diamond', width: current.width, height: current.height })
    } else if (current.type === 'ellipse' && current.radiusX > 2 && current.radiusY > 2) {
      pushShape(shapes, {
        ...base,
        type: 'ellipse',
        radiusX: current.radiusX,
        radiusY: current.radiusY,
      })
    }
  }, [shapes, user.id, user.name, user.color, setDraft])

  const commitText = useCallback(() => {
    const current = textDraftRef.current
    setTextDraft(null)
    if (!current) return

    const value = current.value.trim()
    if (!value) return

    pushShape(shapes, {
      id: nanoid(8),
      type: 'text',
      x: current.worldX,
      y: current.worldY,
      text: value,
      fontSize: current.fontSize,
      stroke: current.stroke,
      strokeWidth: 0,
      author: user.id,
      authorName: user.name,
      authorColor: user.color,
      createdAt: Date.now(),
    })
  }, [shapes, user.id, user.name, user.color, setTextDraft])

  /**
   * Removes whatever sits under the pointer. Konva hit-tests the top node at
   * a screen point, and each node carries its shape id.
   */
  const eraseAtPointer = useCallback(
    (stage) => {
      const point = worldPointer(stage)
      if (!point || !shapes) return

      // Radius is a screen distance, so it feels the same at any zoom; the
      // test itself happens in world space where the shapes live.
      const scale = stage.scaleX() || 1
      const radius = ERASER_RADIUS / scale

      const hits = shapesHitBy(
        shapes.toArray().map((shape) => shape.toJSON()),
        point.x,
        point.y,
        radius
      )
      if (hits.length === 0) return

      hits.forEach((id) => removeShape(shapes, id))
      setSelectedId((current) => (hits.includes(current) ? null : current))
    },
    [shapes]
  )

  const handlePointerDown = useCallback(
    (event) => {
      const stage = event.target.getStage()
      const point = worldPointer(stage)
      if (!point) return

      // An open composer commits before anything else happens.
      if (textDraft) {
        commitText()
        return
      }

      if (readOnly) return

      setHovered(null)
      // Only the primary button acts. A right- or middle-click used to fall
      // through and start a shape that no drag ever finished.
      if ((event.evt?.button ?? 0) !== 0) return

      if (tool === 'select') {
        if (event.target === stage) setSelectedId(null)
        return
      }
      // Erasing is a drag, not just a click: press starts it and every move
      // while held removes what it passes over.
      if (tool === 'eraser') {
        erasingRef.current = true
        eraseAtPointer(stage)
        return
      }

      if (tool === 'text') {
        const pointer = stage.getPointerPosition()
        setTextDraft({
          screenX: pointer.x,
          screenY: pointer.y,
          worldX: point.x,
          worldY: point.y,
          value: '',
          stroke: strokeColor,
          fontSize,
        })
        return
      }

      drawingRef.current = true
      const common = { stroke: strokeColor, strokeWidth, origin: point }

      if (tool === 'pen') {
        setDraft({ ...common, type: 'line', x: 0, y: 0, points: [point.x, point.y] })
      } else if (STRAIGHT.has(tool)) {
        setDraft({ ...common, type: tool, x: 0, y: 0, points: [point.x, point.y, point.x, point.y] })
      } else if (BOXY.has(tool)) {
        setDraft({ ...common, type: tool, x: point.x, y: point.y, width: 0, height: 0 })
      } else if (tool === 'ellipse') {
        setDraft({ ...common, type: 'ellipse', x: point.x, y: point.y, radiusX: 0, radiusY: 0 })
      }
    },
    [
      tool,
      strokeColor,
      strokeWidth,
      fontSize,
      textDraft,
      commitText,
      readOnly,
      eraseAtPointer,
      setDraft,
      setTextDraft,
    ]
  )

  const handlePointerMove = useCallback(
    (event) => {
      const stage = event.target.getStage()
      const point = worldPointer(stage)
      if (!point) return

      const shiftKey = Boolean(event.evt?.shiftKey)
      publishCursor({ x: point.x, y: point.y })

      if (erasingRef.current) {
        eraseAtPointer(stage)
        return
      }
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

        if (STRAIGHT.has(current.type)) {
          // Shift locks the run to 45 degree steps, so horizontals and
          // verticals are actually straight rather than nearly straight.
          const end = shiftKey ? constrain(origin, point) : point
          return { ...current, x: 0, y: 0, points: [origin.x, origin.y, end.x, end.y] }
        }

        if (BOXY.has(current.type)) {
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
    [publishCursor, eraseAtPointer, setDraft]
  )

  const handleShapePointerDown = useCallback(
    (event, shape) => {
      if (readOnly) return
      if (tool === 'select') {
        event.cancelBubble = true
        setSelectedId(shape.id)
      }
    },
    [tool, readOnly]
  )

  const handleHoverStart = useCallback((event, shape) => {
    // Never while a stroke or an erase is in flight - the label would chase
    // the pointer through the work.
    if (drawingRef.current || erasingRef.current) return
    const stage = event.target.getStage()
    const pointer = stage?.getPointerPosition()
    if (!pointer) return

    setHovered({
      id: shape.id,
      name: shape.authorName || 'Unknown',
      color: shape.authorColor || shape.stroke,
      at: shape.createdAt,
      x: pointer.x,
      y: pointer.y,
    })
  }, [])

  const handleHoverEnd = useCallback(() => setHovered(null), [])

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
      const modifier = event.metaKey || event.ctrlKey

      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if (modifier) return

      if (event.key === 'Escape') {
        setSelectedId(null)
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId && !readOnly) {
        event.preventDefault()
        removeShape(shapes, selectedId)
        setSelectedId(null)
        return
      }

      const next = SHORTCUTS[event.key.toLowerCase()]
      if (next) setTool(next)
    },
    [selectedId, shapes, setTool, undo, redo, readOnly]
  )

  // A pointer released outside the canvas must still close the stroke.
  useEffect(() => {
    const onUp = () => {
      erasingRef.current = false
      if (drawingRef.current) commitDraft()
    }
    window.addEventListener('pointerup', onUp)
    return () => window.removeEventListener('pointerup', onUp)
  }, [commitDraft])

  const boardClass = [
    'board',
    isDrawingTool && !readOnly ? 'board--draw' : '',
    tool === 'eraser' && !readOnly ? 'board--erase' : '',
    readOnly ? 'board--locked' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section className="pane pane--board" aria-label="Whiteboard">
      <div
        className={boardClass}
        ref={containerRef}
        tabIndex={0}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={handleKeyDown}
        role="application"
        aria-label="Collaborative canvas"
      >
        <ToolRail
          onClear={() => setConfirmingClear(true)}
          onUndo={undo}
          onRedo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
          disabled={readOnly}
        />
        <CanvasControls />

        {size.width > 0 && size.height > 0 && (
          <Stage
            width={size.width}
            height={size.height}
            scaleX={viewport.scale}
            scaleY={viewport.scale}
            x={viewport.x}
            y={viewport.y}
            draggable={tool === 'select'}
            onContextMenu={(event) => event.evt.preventDefault()}
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
                  draggable={tool === 'select' && !readOnly}
                  isSelected={selectedId === shape.id}
                  onPointerDown={handleShapePointerDown}
                  onDragEnd={handleShapeDragEnd}
                  onHoverStart={handleHoverStart}
                  onHoverEnd={handleHoverEnd}
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

        {hovered && (
          <div
            className="authortip"
            style={{ left: hovered.x + 14 + 'px', top: hovered.y + 14 + 'px' }}
            role="status"
          >
            <span className="authortip__dot" style={{ background: hovered.color }} />
            <span className="authortip__name">{hovered.name}</span>
            {hovered.at && <span className="authortip__when">{formatWhen(hovered.at)}</span>}
          </div>
        )}

        <TextComposer
          draft={textDraft}
          scale={viewport.scale}
          color={textDraft?.stroke}
          fontSize={textDraft?.fontSize ?? fontSize}
          onChange={(value) => setTextDraft((current) => (current ? { ...current, value } : current))}
          onCommit={commitText}
          onCancel={() => setTextDraft(null)}
        />
      </div>

      <ConfirmDialog
        open={confirmingClear}
        title="Clear the board?"
        description="This removes every shape for everyone in the room. It can be undone with Ctrl+Z while you stay on this page."
        confirmLabel="Clear board"
        destructive
        onConfirm={() => {
          clearShapes(shapes)
          setSelectedId(null)
        }}
        onClose={() => setConfirmingClear(false)}
      />
    </section>
  )
}
