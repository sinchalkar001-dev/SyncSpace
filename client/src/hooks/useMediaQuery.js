import { useEffect, useState } from 'react'

/**
 * Subscribes to a media query.
 *
 * Defensive about `matchMedia` because the jsdom build used for tests ships an
 * incomplete window (see src/test/setup.js) — a missing API should degrade to
 * "does not match", never crash a render.
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => read(query))

  useEffect(() => {
    const list = list_(query)
    if (!list) return undefined

    const onChange = (event) => setMatches(event.matches)
    setMatches(list.matches)

    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}

function list_(query) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  const list = window.matchMedia(query)
  return typeof list?.addEventListener === 'function' ? list : null
}

function read(query) {
  return list_(query)?.matches ?? false
}
