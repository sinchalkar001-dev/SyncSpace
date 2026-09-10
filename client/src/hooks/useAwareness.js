import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import throttle from 'lodash.throttle'
import { RATES } from '../lib/presence.js'

/**
 * What would make a row in the people list look different.
 *
 * Identity and presence, and deliberately not the cursor or the viewport: those
 * change many times a second, and a list that re-rendered at pointer rate would
 * redraw every avatar in the header for every twitch of somebody's mouse.
 * Presence is itself rate-limited and deduplicated at the sender, so a room
 * re-renders a few times a second at most, and only when somebody's status
 * actually changes.
 */
const signature = (entry) =>
  entry.clientId +
  '|' +
  (entry.user?.name ?? '') +
  '|' +
  (entry.user?.color ?? '') +
  '|' +
  (entry.presence ? JSON.stringify(entry.presence) : '')

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
        const entry = {
          clientId,
          user: state.user,
          cursor: state.cursor,
          presence: state.presence ?? null,
          view: state.view ?? null,
        }
        if (!entry.user) return
        if (clientId === awareness.clientID) mine = entry
        else next.push(entry)
      })

      const previous = peersRef.current
      const changed =
        previous.length !== next.length ||
        previous.some((entry, index) => signature(entry) !== signature(next[index]))

      if (changed) {
        peersRef.current = next
        setPeers(next)
      } else {
        // Same people doing the same things; only their pointers or views
        // moved. Those are read live by whatever draws them, so the list is
        // updated in place rather than re-rendered.
        for (let i = 0; i < next.length; i += 1) {
          peersRef.current[i].cursor = next[i].cursor
          peersRef.current[i].view = next[i].view
        }
      }

      const selfChanged =
        mine && selfRef.current
          ? signature(mine) !== signature(selfRef.current)
          : mine !== selfRef.current

      if (selfChanged) {
        selfRef.current = mine
        setSelf(mine)
      } else if (mine) {
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
 * Broadcasts this person's pointer on the board.
 *
 * Three things keep this cheap. It is throttled to `RATES.cursorMs`, because a
 * pointer fires far faster than anybody can perceive. Positions are rounded to
 * whole board units, which is invisible on screen and keeps every message a
 * few bytes shorter. And a position identical to the last one sent is not sent
 * at all — a mouse resting on a trackpad still fires moves.
 *
 * `enabled: false` is the privacy switch: the pointer is withdrawn once, and
 * nothing is sent again until it is switched back on.
 */
export function useCursorBroadcast(provider, { wait = RATES.cursorMs, enabled = true } = {}) {
  const last = useRef(null)
  const enabledRef = useRef(enabled)

  const publish = useMemo(
    () =>
      throttle(
        (point) => {
          if (!enabledRef.current || !point) return
          const next = { x: Math.round(point.x), y: Math.round(point.y) }
          if (last.current && last.current.x === next.x && last.current.y === next.y) return
          last.current = next
          provider?.setAwarenessField('cursor', next)
        },
        wait,
        { leading: true, trailing: true }
      ),
    [provider, wait]
  )

  useEffect(() => () => publish.cancel(), [publish])

  useEffect(() => {
    enabledRef.current = enabled
    if (enabled) return
    publish.cancel()
    last.current = null
    provider?.setAwarenessField('cursor', null)
  }, [enabled, provider, publish])

  const clear = useCallback(() => {
    publish.cancel()
    last.current = null
    provider?.setAwarenessField('cursor', null)
  }, [provider, publish])

  return { publish, clear }
}
