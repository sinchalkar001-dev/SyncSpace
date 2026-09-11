import { useEffect, useState } from 'react'
import { resolveCodeAnchors } from '../lib/comments.js'

const NONE = new Map()

/**
 * Where each code comment points now, kept current as the code changes.
 *
 * Resolved again after typing pauses rather than on every keystroke: resolving
 * reads the whole buffer, and a gutter mark that catches up a tenth of a
 * second after the line moved is indistinguishable from one that never lagged.
 *
 * Reads the shared text only. Nothing is written to it, so a room full of
 * comments adds nothing to anybody's Yjs traffic.
 */
export function useCodeAnchors(threads, yText, { enabled = true, delay = 120 } = {}) {
  const [located, setLocated] = useState(NONE)

  useEffect(() => {
    if (!enabled || !yText) {
      setLocated(NONE)
      return undefined
    }

    const codeThreads = threads.filter((thread) => thread.anchor?.kind === 'code')
    if (codeThreads.length === 0) {
      setLocated(NONE)
      return undefined
    }

    const resolve = () => setLocated(resolveCodeAnchors(codeThreads, yText))
    resolve()

    let timer = null
    const onChange = () => {
      clearTimeout(timer)
      timer = setTimeout(resolve, delay)
    }

    yText.observe(onChange)
    return () => {
      clearTimeout(timer)
      yText.unobserve(onChange)
    }
  }, [threads, yText, enabled, delay])

  return located
}
