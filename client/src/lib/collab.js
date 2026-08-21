import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { COLLAB_URL } from './env.js'

/**
 * One Yjs document per room. The document is the source of truth for both
 * panes — the server only relays and persists updates, it never owns state.
 *
 *   shapes -> Y.Array<Y.Map>  whiteboard geometry
 *   code   -> Y.Text          Monaco buffer, bound via y-monaco
 *   meta   -> Y.Map           room-level settings (editor language, ...)
 */
export function createCollabSession({ roomId, user, token }) {
  const doc = new Y.Doc()
  const shapes = doc.getArray('shapes')

  const provider = new HocuspocusProvider({
    url: COLLAB_URL,
    name: roomId,
    document: doc,
    token: token || 'anonymous',
    // Reconnect quietly; the UI surfaces status via the `status` event.
    preserveConnection: false,
  })

  provider.setAwarenessField('user', user)

  // Undo is scoped to the whiteboard and, by tracking only the default origin,
  // to this user's own edits — remote changes arrive tagged with the provider
  // and are never rolled back by your Ctrl+Z. Monaco keeps its own stack.
  const undoManager = new Y.UndoManager(shapes, { captureTimeout: 400 })

  return {
    doc,
    provider,
    shapes,
    undoManager,
    code: doc.getText('code'),
    meta: doc.getMap('meta'),
    destroy() {
      undoManager.destroy()
      provider.destroy()
      doc.destroy()
    },
  }
}

/** Converts a shape Y.Map into a plain object for React rendering. */
export function shapeToObject(yShape) {
  return yShape instanceof Y.Map ? yShape.toJSON() : yShape
}

/** Appends a shape to the shared array as a Y.Map so props merge independently. */
export function pushShape(shapes, shape) {
  const yShape = new Y.Map()
  Object.entries(shape).forEach(([key, value]) => yShape.set(key, value))
  shapes.push([yShape])
  return yShape
}

export function updateShape(shapes, id, patch) {
  const doc = shapes.doc
  const apply = () => {
    for (let i = 0; i < shapes.length; i += 1) {
      const item = shapes.get(i)
      if (item instanceof Y.Map && item.get('id') === id) {
        Object.entries(patch).forEach(([key, value]) => item.set(key, value))
        return
      }
    }
  }
  doc ? doc.transact(apply) : apply()
}

export function removeShape(shapes, id) {
  for (let i = 0; i < shapes.length; i += 1) {
    const item = shapes.get(i)
    if (item instanceof Y.Map && item.get('id') === id) {
      shapes.delete(i, 1)
      return
    }
  }
}

export function clearShapes(shapes) {
  if (shapes.length) shapes.delete(0, shapes.length)
}

/** Index of a shape in the shared array, or -1. */
function indexOfShape(shapes, id) {
  for (let i = 0; i < shapes.length; i += 1) {
    const item = shapes.get(i)
    if (item instanceof Y.Map && item.get('id') === id) return i
  }
  return -1
}

/**
 * Moves a shape one step through paint order.
 *
 * Y.Array has no move, so this deletes and re-inserts. Both happen in one
 * transaction, which keeps it a single undo step and a single broadcast.
 */
export function reorderShape(shapes, id, direction) {
  const index = indexOfShape(shapes, id)
  if (index < 0) return

  const target = direction === 'forward' ? index + 1 : index - 1
  if (target < 0 || target >= shapes.length) return

  const apply = () => {
    const json = shapes.get(index).toJSON()
    shapes.delete(index, 1)
    const fresh = new Y.Map()
    Object.entries(json).forEach(([key, value]) => fresh.set(key, value))
    shapes.insert(target, [fresh])
  }

  shapes.doc ? shapes.doc.transact(apply) : apply()
}

/** Appends copies of the given shapes, offset so they are visibly separate. */
export function duplicateShapes(shapes, ids, offset = 16) {
  const copies = []

  const apply = () => {
    for (let i = 0; i < shapes.length; i += 1) {
      const item = shapes.get(i)
      if (!(item instanceof Y.Map) || !ids.includes(item.get('id'))) continue
      const json = item.toJSON()
      // A copy is a new shape, not the same one twice: it needs its own id or
      // every later edit would address both.
      copies.push({
        ...json,
        id: nanoid(8),
        x: (json.x || 0) + offset,
        y: (json.y || 0) + offset,
      })
    }
    copies.forEach((copy) => pushShape(shapes, copy))
  }

  shapes.doc ? shapes.doc.transact(apply) : apply()
  return copies.map((copy) => copy.id)
}
