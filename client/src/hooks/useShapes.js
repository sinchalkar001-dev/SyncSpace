import { useEffect, useState } from 'react'

/** Mirrors a Y.Array of shape maps into plain React state. */
export function useShapes(shapes) {
  const [list, setList] = useState([])

  useEffect(() => {
    if (!shapes) {
      setList([])
      return undefined
    }

    const read = () => setList(shapes.toArray().map((shape) => shape.toJSON()))

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
