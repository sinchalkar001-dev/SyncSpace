import { useEffect, useState } from 'react'
import * as Y from 'yjs'

/**
 * Mirrors a Y.Array of shape maps into plain React state.
 *
 * A shape that did not change keeps the object it had. Every shape on the board
 * is a memoised node, and serialising the whole array afresh on every change
 * handed each of them a new object — so somebody else nudging one rectangle
 * re-rendered every shape in the room. Each map's plain copy is kept until an
 * event says something inside that map changed.
 */
export function useShapes(shapes) {
  const [list, setList] = useState([])

  useEffect(() => {
    if (!shapes) {
      setList([])
      return undefined
    }

    const copies = new WeakMap()

    const plain = (item) => {
      if (!(item instanceof Y.Map)) return item
      let copy = copies.get(item)
      if (!copy) {
        copy = item.toJSON()
        copies.set(item, copy)
      }
      return copy
    }

    const read = (events = []) => {
      // An event's path leads from this array to what changed, and its first
      // step is the index of the shape the change happened inside. Adding or
      // removing a shape is an event on the array itself, with an empty path,
      // and leaves every existing shape as it was.
      for (const event of events) {
        const index = event.path[0]
        if (typeof index === 'number') copies.delete(shapes.get(index))
      }
      setList(shapes.toArray().map(plain))
    }

    read()

    /**
     * `observeDeep`, not `observe`.
     *
     * A shape's geometry and its flags live in a Y.Map *inside* this array, and
     * `observe` only fires when the array itself gains or loses an entry. Every
     * change to an existing shape — moving it, locking it, restyling it — is a
     * change inside an entry, so it never reached React at all.
     *
     * Locally that was invisible: Konva has already moved the node it is
     * dragging, so the person doing the dragging sees what they expect. For
     * everyone else in the room the shape stayed exactly where it was.
     *
     * This does not re-fire for the code buffer or the room's metadata. Those
     * are separate top-level types on the document — `doc.getText('code')` and
     * `doc.getMap('meta')` — not children of this array, so a deep observer
     * here cannot see them.
     */
    shapes.observeDeep(read)
    return () => shapes.unobserveDeep(read)
  }, [shapes])

  return list
}
