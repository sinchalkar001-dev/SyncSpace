import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import throttle from 'lodash.throttle'

/** Live list of everyone in the room, split into `self` and `peers`. */
export function useAwareness(provider) {
  const [peers, setPeers] = useState([])
  const [self, setSelf] = useState(null)
  const peersRef = useRef(peers)
  const selfRef = useRef(self)

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

      // Only update state if identity (not cursor) actually changed
      const prevPeers = peersRef.current
      const identityChanged =
        prevPeers.length !== next.length ||
        prevPeers.some((p, i) => {
          const n = next[i]
          return p.clientId !== n.clientId || p.user?.name !== n.user?.name || p.user?.color !== n.user?.color
        })

      if (identityChanged) {
        peersRef.current = next
        setPeers(next)
      } else {
        // Update cursor data in-place without triggering re-renders
        for (let i = 0; i < next.length; i++) {
          if (peersRef.current[i]) peersRef.current[i].cursor = next[i].cursor
        }
      }

      if (selfRef.current?.clientId !== mine?.clientId || selfRef.current?.user?.name !== mine?.user?.name) {
        selfRef.current = mine
        setSelf(mine)
      } else if (selfRef.current && mine) {
        selfRef.current.cursor = mine.cursor
      }
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
