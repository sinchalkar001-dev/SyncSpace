import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Layer, Stage } from 'react-konva'
import { nanoid } from 'nanoid'
import {
  clearShapes,
  duplicateShapes,
  pushShape,
  removeShape,
  reorderShape,
  updateShape,
} from '../../lib/collab.js'
import { shapesHitBy, shapesInRect, unionBounds } from '../../lib/hitTest.js'
import { useShapes } from '../../hooks/useShapes.js'
import { useElementSize } from '../../hooks/useElementSize.js'
import { useCursorBroadcast } from '../../hooks/useAwareness.js'
import { useUndo } from '../../hooks/useUndo.js'
import { MAX_SCALE, MIN_SCALE, useUIStore } from '../../store/uiStore.js'
import { ConfirmDialog } from '../ui/Modal.jsx'
import { formatWhen } from '../../lib/rooms.js'
import { SelectionActions } from './SelectionActions.jsx'
import { ShapeNode } from './ShapeNode.jsx'
import { RemoteCursors } from './RemoteCursors.jsx'
import { RemoteSelections } from './RemoteSelections.jsx'
import { centerOn, viewCenter } from '../../lib/presence.js'
import { ToolRail } from './ToolRail.jsx'
import { CanvasControls } from './CanvasControls.jsx'
import { TextComposer } from './TextComposer.jsx'
import { CommentPins } from './CommentPins.jsx'
import { regionAnchor, shapeAnchor } from '../../lib/comments.js'

const MIN_POINT_DISTANCE = 2

const NO_THREADS = []

// How far, in screen pixels, a press with the comment tool may travel and still
// count as a click on one spot rather than a drag around an area.
const COMMENT_DRAG = 8

// How close to a shape, in screen pixels, a comment click has to land to be
// attached to it rather than to the empty board beside it.
const COMMENT_REACH = 6

// The eraser reaches this far, in screen pixels. A bare point test makes thin
// strokes almost impossible to hit while dragging, which reads as "the eraser
// does not work". Screen units on purpose, so the reach feels the same at any
// zoom level.
const ERASER_RADIUS = 14

// How far a pasted or duplicated copy sits from its original.
const PASTE_OFFSET = 16

const SHORTCUTS = {
  v: 'select',
  p: 'pen',
  h: 'hand',
  l: 'segment',
  a: 'arrow',
  r: 'rect',
  d: 'diamond',
  o: 'ellipse',
  t: 'text',
  e: 'eraser',
  c: 'comment',
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

export function Whiteboard({
  shapes,
  provider,
  undoManager,
  peers,
  user,
  readOnly = false,
  presence,
  sharing = true,
  commentThreads = NO_THREADS,
  canComment = false,
  onComment,
  onOpenThread,
  activeThreadId = null,
  pendingAnchor = null,
}) {
  const [containerRef, size] = useElementSize()
  // A comment being placed: where the press began, and the shape under it.
  const placingRef = useRef(null)
  const [placing, setPlacing] = useState(null)
  const [draft, setDraftState] = useState(null)
  const [textDraft, setTextDraftState] = useState(null)
  // Mirrors of the two drafts. Committing a shape is a side effect, and side
  // effects must not live inside a setState updater: React invokes updaters
  // twice under StrictMode, which committed every shape twice - two identical
  // shapes stacked exactly on top of each other.
  const draftRef = useRef(null)
  const textDraftRef = useRef(null)
  // A selection is a set: shift-click adds, a marquee sweeps up several.
  const [selectedIds, setSelectedIds] = useState([])
  // Screen-space rectangle while a marquee is being dragged.
  const [marquee, setMarquee] = useState(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const drawingRef = useRef(false)
  const erasingRef = useRef(false)
  const marqueeRef = useRef(null)
  const stageRef = useRef(null)
  const clipboardRef = useRef([])
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
  const { publish: publishCursor, clear: clearCursor } = useCursorBroadcast(provider, {
    enabled: sharing,
  })
  const { canUndo, canRedo, undo, redo } = useUndo(undoManager)

  /**
   * Presence, reported from the board.
   *
   * Read through refs so the pointer handlers can report without depending on
   * presence - they would otherwise be rebuilt whenever anybody's status
   * changed, which on a busy board is several times a second.
   */
  const presenceRef = useRef(presence)
  const sizeRef = useRef(size)
  const listRef = useRef(list)
  useEffect(() => {
    presenceRef.current = presence
    sizeRef.current = size
    listRef.current = list
  })

  // What this person has selected, for everybody else's outline. Skipped on
  // mount: an empty selection at load is not somebody choosing nothing.
  const reportedSelection = useRef(false)
  useEffect(() => {
    if (!reportedSelection.current) {
      reportedSelection.current = true
      return
    }
    presenceRef.current?.reportBoard({ selected: selectedIds })
  }, [selectedIds])

  // Where this person is looking, held ready for the moment somebody follows
  // them. Nothing leaves the machine from here unless somebody does.
  useEffect(() => {
    if (!size.width || !size.height) return
    presenceRef.current?.reportView(viewCenter(viewport, size))
  }, [viewport, size])

  /**
   * Somebody else's view, arriving because this person follows or focused
   * them. A followed view is matched outright, scale included; a focus keeps
   * this person's own zoom and only brings the other person's work into the
   * middle - their selection if they have one, their pointer if not.
   */
  useEffect(() => {
    const navigator = presence?.navigator
    if (!navigator) return undefined

    return navigator.on('board', ({ view, point, selected } = {}) => {
      const frame = sizeRef.current
      if (!frame?.width) return

      if (view) {
        setViewport(centerOn(view, frame))
        return
      }

      const chosen = selected?.length
        ? unionBounds(listRef.current.filter((shape) => selected.includes(shape.id)))
        : null

      const target = chosen
        ? { cx: chosen.x + chosen.width / 2, cy: chosen.y + chosen.height / 2 }
        : point
          ? { cx: point.x, cy: point.y }
          : null

      if (target) setViewport((current) => centerOn({ ...target, scale: current.scale }, frame))
    })
  }, [presence?.navigator, setViewport])

  const isDrawingTool =
    tool !== 'select' && tool !== 'eraser' && tool !== 'hand' && tool !== 'comment'
  const commenting = tool === 'comment' && canComment

  /**
   * Resolved threads leave the board, as they leave the editor's gutter: a
   * finished conversation should not keep marking the work. The one open in
   * the panel stays, so going to a resolved comment still lands on something.
   */
  const boardThreads = useMemo(
    () =>
      commentThreads.filter(
        (thread) =>
          (thread.anchor?.kind === 'shape' || thread.anchor?.kind === 'region') &&
          (thread.status !== 'resolved' || thread.id === activeThreadId)
      ),
    [commentThreads, activeThreadId]
  )

  const boardDraft =
    placing ?? (pendingAnchor?.kind === 'shape' || pendingAnchor?.kind === 'region' ? pendingAnchor : null)

  /** Turns a finished marquee drag into a selection. */
  const commitMarquee = useCallback(
    (stage) => {
      const origin = marqueeRef.current
      marqueeRef.current = null
      setMarquee(null)
      if (!origin || !stage || !shapes) return

      const pointer = { x: origin.toX, y: origin.toY }
      // A tap is not a sweep; ignore anything too small to be deliberate.
      if (Math.abs(pointer.x - origin.x) < 4 && Math.abs(pointer.y - origin.y) < 4) return

      const transform = stage.getAbsoluteTransform().copy().invert()
      const a = transform.point(origin)
      const b = transform.point(pointer)
      const rect = {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y),
      }

      // Use the already-serialized list from useShapes instead of re-serializing
      setSelectedIds(shapesInRect(list, rect))
    },
    [shapes, list]
  )

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

      // Use the already-serialized list from useShapes instead of re-serializing
      const hits = shapesHitBy(list, point.x, point.y, radius)
      if (hits.length === 0) return

      hits.forEach((id) => removeShape(shapes, id))
      setSelectedIds((current) => current.filter((id) => !hits.includes(id)))
    },
    [shapes, list]
  )

  /**
   * Finishes placing a comment. A press that did not travel is a comment on
   * the shape under it, or on that spot when there is no shape; a drag is a
   * comment on the area dragged out. Nothing is written to the board either
   * way — the anchor goes to the comments panel, where the comment is written.
   */
  const commitComment = useCallback(
    (stage) => {
      const started = placingRef.current
      placingRef.current = null
      setPlacing(null)
      if (!started) return

      const end = (stage && worldPointer(stage)) || started.origin
      const scale = stage?.scaleX() || 1
      const travelled = Math.hypot(end.x - started.origin.x, end.y - started.origin.y) * scale

      if (travelled >= COMMENT_DRAG) onComment?.(regionAnchor(started.origin, end))
      else if (started.shape) onComment?.(shapeAnchor(started.shape, started.origin))
      else onComment?.(regionAnchor(started.origin))
    },
    [onComment]
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

      // Before the read-only check on purpose: commenting changes nothing on
      // the board, and it is the one thing a commenter came here to do.
      if (tool === 'comment') {
        if (!canComment || (event.evt?.button ?? 0) !== 0) return
        setHovered(null)
        // Shapes paint in list order, so the last hit is the one on top.
        const hits = shapesHitBy(list, point.x, point.y, COMMENT_REACH / (stage.scaleX() || 1))
        const shape = hits.length ? list.find((candidate) => candidate.id === hits[hits.length - 1]) : null
        placingRef.current = { origin: point, shape: shape ?? null }
        setPlacing(regionAnchor(point))
        return
      }

      if (readOnly) return

      setHovered(null)
      // Only the primary button acts. A right- or middle-click used to fall
      // through and start a shape that no drag ever finished.
      if ((event.evt?.button ?? 0) !== 0) return

      if (tool === 'hand') return

      if (tool === 'select') {
        if (event.target === stage) {
          setSelectedIds([])
          // An empty-canvas drag with the select tool sweeps a marquee.
          const pointer = stage.getPointerPosition()
          if (pointer) marqueeRef.current = { x: pointer.x, y: pointer.y, toX: pointer.x, toY: pointer.y }
        }
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
      canComment,
      list,
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
      presenceRef.current?.touch()

      if (placingRef.current) {
        setPlacing(regionAnchor(placingRef.current.origin, point))
        return
      }

      if (erasingRef.current) {
        eraseAtPointer(stage)
        return
      }

      if (marqueeRef.current) {
        const pointer = stage.getPointerPosition()
        if (!pointer) return
        const origin = marqueeRef.current
        origin.toX = pointer.x
        origin.toY = pointer.y
        setMarquee({
          x: Math.min(origin.x, pointer.x),
          y: Math.min(origin.y, pointer.y),
          width: Math.abs(pointer.x - origin.x),
          height: Math.abs(pointer.y - origin.y),
        })
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
      if (tool !== 'select') return

      event.cancelBubble = true
      const additive = event.evt?.shiftKey || event.evt?.metaKey || event.evt?.ctrlKey

      setSelectedIds((current) => {
        if (!additive) return current.includes(shape.id) ? current : [shape.id]
        return current.includes(shape.id)
          ? current.filter((id) => id !== shape.id)
          : [...current, shape.id]
      })
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

  const handleShapeDragEnd = useCallback(
    (id, patch) => {
      const moved = list.find((shape) => shape.id === id)
      const dx = patch.x - (moved?.x || 0)
      const dy = patch.y - (moved?.y || 0)

      const apply = () => {
        updateShape(shapes, id, patch)
        // Drag one of several and the rest of the selection travels with it.
        if (!selectedIds.includes(id)) return
        selectedIds
          .filter((other) => other !== id)
          .forEach((other) => {
            const shape = list.find((candidate) => candidate.id === other)
            if (!shape || shape.locked) return
            updateShape(shapes, other, { x: (shape.x || 0) + dx, y: (shape.y || 0) + dy })
          })
      }

      shapes.doc ? shapes.doc.transact(apply) : apply()
    },
    [shapes, selectedIds, list]
  )

  const selection = useMemo(
    () => list.filter((shape) => selectedIds.includes(shape.id)),
    [list, selectedIds]
  )

  // World bounds converted to board pixels, so the action bar can sit over it.
  const selectionBox = useMemo(() => {
    if (selection.length === 0) return null
    const bounds = unionBounds(selection)
    if (!bounds) return null
    return {
      x: bounds.x * viewport.scale + viewport.x,
      y: bounds.y * viewport.scale + viewport.y,
      width: bounds.width * viewport.scale,
      height: bounds.height * viewport.scale,
    }
  }, [selection, viewport])

  const allLocked = selection.length > 0 && selection.every((shape) => shape.locked)

  const runOnSelection = useCallback(
    (fn) => {
      const apply = () => selectedIds.forEach(fn)
      shapes.doc ? shapes.doc.transact(apply) : apply()
    },
    [shapes, selectedIds]
  )

  const selectionActions = useMemo(
    () => ({
      duplicate: () => setSelectedIds(duplicateShapes(shapes, selectedIds)),
      copy: () => {
        clipboardRef.current = selection
      },
      forward: () => runOnSelection((id) => reorderShape(shapes, id, 'forward')),
      backward: () => runOnSelection((id) => reorderShape(shapes, id, 'backward')),
      toggleLock: () => runOnSelection((id) => updateShape(shapes, id, { locked: !allLocked })),
      remove: () => {
        runOnSelection((id) => removeShape(shapes, id))
        setSelectedIds([])
      },
    }),
    [shapes, selectedIds, selection, runOnSelection, allLocked]
  )

  const handleWheel = useCallback(
    (event) => {
      event.evt.preventDefault()
      // Zooming is taking the view back; following somebody else ends here.
      presenceRef.current?.unfollow()
      presenceRef.current?.reportBoard({ engaged: true })
      const stage = event.target.getStage()
      const pointer = stage.getPointerPosition()
      if (!pointer) return

      setViewport((current) => {
        const oldScale = current.scale
        const anchor = {
          x: (pointer.x - current.x) / oldScale,
          y: (pointer.y - current.y) / oldScale,
        }
        const factor = event.evt.deltaY > 0 ? 1 / 1.08 : 1.08
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * factor))
        return {
          scale,
          x: pointer.x - anchor.x * scale,
          y: pointer.y - anchor.y * scale,
        }
      })
    },
    [setViewport]
  )

  const handleStageDragEnd = useCallback(
    (event) => {
      if (event.target !== event.target.getStage()) return
      setViewport((current) => ({ ...current, x: event.target.x(), y: event.target.y() }))
    },
    [setViewport]
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
      if (modifier) {
        const key = event.key.toLowerCase()
        if (readOnly) return

        if (key === 'c' && selectedIds.length) {
          event.preventDefault()
          clipboardRef.current = list.filter((shape) => selectedIds.includes(shape.id))
          return
        }

        if (key === 'v' && clipboardRef.current.length) {
          event.preventDefault()
          const pasted = clipboardRef.current.map((shape) => ({
            ...shape,
            id: nanoid(8),
            x: (shape.x || 0) + PASTE_OFFSET,
            y: (shape.y || 0) + PASTE_OFFSET,
          }))
          pasted.forEach((shape) => pushShape(shapes, shape))
          // Paste again and the next copy lands further along, rather than
          // stacking invisibly on the last one.
          clipboardRef.current = pasted
          setSelectedIds(pasted.map((shape) => shape.id))
          return
        }

        if (key === 'd' && selectedIds.length) {
          event.preventDefault()
          setSelectedIds(duplicateShapes(shapes, selectedIds))
          return
        }

        if (key === 'a') {
          event.preventDefault()
          setSelectedIds(list.map((shape) => shape.id).filter(Boolean))
          return
        }

        return
      }

      if (event.key === 'Escape') {
        setSelectedIds([])
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length && !readOnly) {
        event.preventDefault()
        selectedIds.forEach((id) => removeShape(shapes, id))
        setSelectedIds([])
        return
      }

      const next = SHORTCUTS[event.key.toLowerCase()]
      if (next) setTool(next)
    },
    [selectedIds, list, shapes, setTool, undo, redo, readOnly]
  )

  // A pointer released outside the canvas must still close the stroke.
  useEffect(() => {
    const onUp = () => {
      erasingRef.current = false
      if (marqueeRef.current) commitMarquee(stageRef.current)
      marqueeRef.current = null
      setMarquee(null)
      if (drawingRef.current) commitDraft()
      if (placingRef.current) commitComment(stageRef.current)
    }
    window.addEventListener('pointerup', onUp)
    return () => window.removeEventListener('pointerup', onUp)
  }, [commitDraft, commitMarquee, commitComment])

  const boardClass = [
    'board',
    (isDrawingTool && !readOnly) || commenting ? 'board--draw' : '',
    tool === 'eraser' && !readOnly ? 'board--erase' : '',
    tool === 'hand' ? 'board--pan' : '',
    readOnly && !commenting ? 'board--locked' : '',
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
          canComment={canComment}
        />
        <CanvasControls />

        {size.width > 0 && size.height > 0 && (
          <Stage
            ref={stageRef}
            width={size.width}
            height={size.height}
            scaleX={viewport.scale}
            scaleY={viewport.scale}
            x={viewport.x}
            y={viewport.y}
            draggable={tool === 'hand'}
            onContextMenu={(event) => event.evt.preventDefault()}
            onPointerDown={(event) => {
              // Reaching for the board takes it back from whoever this person
              // was following - drawing while the view is steered by somebody
              // else puts every stroke in the wrong place.
              presenceRef.current?.unfollow()
              presenceRef.current?.reportBoard({ engaged: true })
              handlePointerDown(event)
            }}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => {
              const drew = Boolean(draftRef.current) || erasingRef.current
              commitMarquee(event.target.getStage())
              commitDraft()
              commitComment(event.target.getStage())
              if (drew && !readOnly) presenceRef.current?.reportBoard({ drew: true })
            }}
            onPointerLeave={clearCursor}
            onDragStart={(event) => {
              if (event.target === event.target.getStage()) presenceRef.current?.unfollow()
            }}
            onDragEnd={handleStageDragEnd}
            onWheel={handleWheel}
          >
            <Layer>
              {list.map((shape) => (
                <ShapeNode
                  key={shape.id}
                  shape={shape}
                  draggable={tool === 'select' && !readOnly && !shape.locked}
                  isSelected={selectedIds.includes(shape.id)}
                  onPointerDown={handleShapePointerDown}
                  onDragEnd={handleShapeDragEnd}
                  onHoverStart={handleHoverStart}
                  onHoverEnd={handleHoverEnd}
                />
              ))}
            </Layer>
            <Layer listening={false}>
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
            {/* Other people's selections sit under their pointers, so a
                name tag never hides the cursor it belongs to. */}
            <Layer listening={false}>
              <RemoteSelections peers={peers} shapes={list} scale={viewport.scale} />
            </Layer>
            {/* Listening, unlike the layers either side of it: a pin is a
                thing to click. Above the shapes, under other people's
                pointers. */}
            <Layer>
              <CommentPins
                threads={boardThreads}
                shapes={list}
                scale={viewport.scale}
                activeId={activeThreadId}
                draft={boardDraft}
                onOpen={onOpenThread}
              />
            </Layer>
            <Layer listening={false}>
              <RemoteCursors peers={peers} scale={viewport.scale} provider={provider} />
            </Layer>
          </Stage>
        )}

        {marquee && (
          <div
            className="marquee"
            style={{
              left: marquee.x + 'px',
              top: marquee.y + 'px',
              width: marquee.width + 'px',
              height: marquee.height + 'px',
            }}
            aria-hidden="true"
          />
        )}

        {tool === 'select' && !readOnly && selectionBox && (
          <SelectionActions
            box={selectionBox}
            count={selection.length}
            locked={allLocked}
            board={size}
            onDuplicate={selectionActions.duplicate}
            onCopy={selectionActions.copy}
            onForward={selectionActions.forward}
            onBackward={selectionActions.backward}
            onToggleLock={selectionActions.toggleLock}
            onDelete={selectionActions.remove}
          />
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
          setSelectedIds([])
        }}
        onClose={() => setConfirmingClear(false)}
      />
    </section>
  )
}
