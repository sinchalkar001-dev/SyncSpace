import * as Y from 'yjs'
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
