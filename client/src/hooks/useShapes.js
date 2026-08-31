import { useEffect, useRef, useState } from 'react'

/** Mirrors a Y.Array of shape maps into plain React state. */
export function useShapes(shapes) {
  const [list, setList] = useState([])
  const listRef = useRef(list)
  listRef.current = list

  useEffect(() => {
    if (!shapes) {
      setList([])
      return undefined
    }

    const read = () => {
      const next = shapes.toArray().map((shape) => shape.toJSON())
      setList((prev) => {
        if (prev.length === next.length && prev.every((s, i) => s.id === next[i].id)) return prev
        return next
      })
    }

    read()
    // Use observe (not observeDeep) so code/meta changes don't trigger re-serialization
    shapes.observe(read)
    return () => shapes.unobserve(read)
  }, [shapes])

  return list
}
