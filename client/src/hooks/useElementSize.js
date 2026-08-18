import { useLayoutEffect, useRef, useState } from 'react'

/** Tracks a container's pixel size so the Konva stage can fill it. */
export function useElementSize() {
  const ref = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return undefined

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ width: Math.round(width), height: Math.round(height) })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, size]
}
