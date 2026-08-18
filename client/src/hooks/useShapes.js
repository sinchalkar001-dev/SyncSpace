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
    shapes.observeDeep(read)
    return () => shapes.unobserveDeep(read)
  }, [shapes])

  return list
}
