import { useCallback, useEffect, useMemo, useState } from 'react'
import throttle from 'lodash.throttle'

/** Live list of everyone in the room, split into `self` and `peers`. */
export function useAwareness(provider) {
  const [peers, setPeers] = useState([])
  const [self, setSelf] = useState(null)

  useEffect(() => {
    const awareness = provider?.awareness
    if (!awareness) return undefined

    const read = () => {
      const next = []
      let mine = null
      awareness.getStates().forEach((state, clientId) => {
        const entry = { clientId, user: state.user, cursor: state.cursor }
        if (!entry.user) return
        if (clientId === awareness.clientID) mine = entry
        else next.push(entry)
      })
      setPeers(next)
      setSelf(mine)
    }

    read()
    awareness.on('change', read)
    return () => awareness.off('change', read)
  }, [provider])

  return { peers, self }
}

/**
 * Throttled cursor broadcaster. Pointer moves fire far faster than anyone can
 * perceive, so they are capped rather than sent per event.
 */
export function useCursorBroadcast(provider, wait = 40) {
  const publish = useMemo(
    () =>
      throttle(
        (point) => {
          provider?.setAwarenessField('cursor', point)
        },
        wait,
        { leading: true, trailing: true }
      ),
    [provider, wait]
  )

  useEffect(() => () => publish.cancel(), [publish])

  const clear = useCallback(() => {
    publish.cancel()
    provider?.setAwarenessField('cursor', null)
  }, [provider, publish])

  return { publish, clear }
}
