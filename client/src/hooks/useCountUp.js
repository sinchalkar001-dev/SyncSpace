import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../lib/motion.js'

/**
 * Counts from the previous value to the next one over `duration`.
 *
 * Eased with the same cubic curve the CSS uses, so a counter finishing feels
 * like part of the same motion system rather than a separate widget.
 *
 * Anyone who has asked for reduced motion gets the final number immediately —
 * the information is the point, the animation is decoration.
 */
export function useCountUp(value, duration = 700) {
  const [display, setDisplay] = useState(() => (prefersReducedMotion() ? value : 0))
  const fromRef = useRef(0)
  const frameRef = useRef(0)

  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplay(value)
      fromRef.current = value
      return undefined
    }

    const from = fromRef.current
    const delta = value - from
    if (delta === 0) return undefined

    const start = performance.now()

    const tick = (now) => {
      const progress = Math.min((now - start) / duration, 1)
      // easeOutCubic — fast out of the gate, settles gently on the number.
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplay(Math.round(from + delta * eased))

      if (progress < 1) frameRef.current = requestAnimationFrame(tick)
      else fromRef.current = value
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameRef.current)
  }, [value, duration])

  return display
}
