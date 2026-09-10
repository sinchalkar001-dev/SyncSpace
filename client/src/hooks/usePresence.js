import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import throttle from 'lodash.throttle'
import {
  ACTIVE_MS,
  MAX_SELECTED,
  RATES,
  activityOf,
  buildPresence,
  canFocus,
  createNavigator,
  fileNameFor,
  viewKey,
} from '../lib/presence.js'

/** How often an otherwise quiet client re-checks whether it has gone idle. */
const IDLE_CHECK_MS = 10000

/**
 * This person's presence, going out; and following somebody else's, coming in.
 *
 * The panes report what happens in them — a caret moved, a stroke finished, a
 * shape was selected — through the `report*` functions, which are safe to call
 * on every keystroke and every pointer move: they write to a ref and ask for a
 * throttled flush, and the flush sends nothing unless the result differs from
 * what was last sent. So typing a hundred characters on one line sends the
 * presence field once, not a hundred times.
 *
 * Follow mode is where the traffic saving is largest. Following somebody needs
 * their viewport, which changes on every pan and zoom — and most of the time
 * nobody is following anybody. So a follower announces who it follows in its
 * own presence, and a client sends its viewport only while at least one peer
 * says it is following. A room where nobody follows anybody sends no viewports
 * at all.
 */
export function usePresence({
  provider,
  canEditCode = true,
  canEditBoard = true,
  language,
  sharing = true,
  onFollowEnded,
} = {}) {
  const navigator = useMemo(() => createNavigator(), [])

  const local = useRef({
    surface: null,
    line: null,
    selected: [],
    lastTypedAt: 0,
    lastDrewAt: 0,
    lastInputAt: Date.now(),
    hidden: typeof document !== 'undefined' ? document.hidden : false,
  })

  const config = useRef({ canEditCode, canEditBoard, language, sharing })
  const sent = useRef({ key: null, activity: null, view: 'none' })

  const [following, setFollowing] = useState(null)
  const followingRef = useRef(null)
  const leaderName = useRef(null)
  const leaderSeen = useRef({ surface: null, line: null, view: null })

  const [followers, setFollowers] = useState([])
  const followersKey = useRef('')
  const followerCount = useRef(0)
  const view = useRef(null)

  const endedRef = useRef(onFollowEnded)
  useEffect(() => {
    endedRef.current = onFollowEnded
  }, [onFollowEnded])

  /** Builds the presence field from what is known and sends it if it changed. */
  const flush = useCallback(() => {
    if (!provider) return

    const { canEditCode: code, canEditBoard: board, language: lang, sharing: share } = config.current
    const state = local.current

    const presence = buildPresence({
      activity: activityOf({
        ...state,
        selectedCount: state.selected.length,
        canEditCode: code,
        canEditBoard: board,
        now: Date.now(),
      }),
      surface: state.surface,
      line: state.line,
      file: fileNameFor(lang),
      selected: state.selected,
      sharing: share,
      following: followingRef.current,
    })

    const key = JSON.stringify(presence)
    if (key === sent.current.key) return

    sent.current.key = key
    sent.current.activity = presence.activity
    provider.setAwarenessField('presence', presence)
  }, [provider])

  const schedule = useMemo(
    () => throttle(flush, RATES.presenceMs, { leading: true, trailing: true }),
    [flush]
  )

  useEffect(() => () => schedule.cancel(), [schedule])

  /**
   * "Editing" and "drawing" wear off on their own a few seconds after the last
   * keystroke, with no new input to trigger a flush. One timer per burst of
   * activity, pushed back on every keystroke, sends the change exactly once.
   */
  const decayTimer = useRef(0)
  const decay = useCallback(() => {
    clearTimeout(decayTimer.current)
    decayTimer.current = setTimeout(flush, ACTIVE_MS + 50)
  }, [flush])

  useEffect(() => () => clearTimeout(decayTimer.current), [])

  // Idle is the same problem over a longer span. The check is local; a message
  // goes out only on the flush where the answer actually changes.
  useEffect(() => {
    const timer = setInterval(flush, IDLE_CHECK_MS)
    return () => clearInterval(timer)
  }, [flush])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onVisibility = () => {
      local.current.hidden = document.hidden
      if (!document.hidden) local.current.lastInputAt = Date.now()
      flush()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [flush])

  /** Sends the viewport, or withdraws it, depending on whether anyone follows. */
  const sendView = useCallback(() => {
    if (!provider) return
    const value =
      config.current.sharing && followerCount.current > 0 && view.current ? view.current : null
    const key = viewKey(value)
    if (key === sent.current.view) return
    sent.current.view = key
    provider.setAwarenessField('view', value)
  }, [provider])

  const scheduleView = useMemo(
    () => throttle(sendView, RATES.viewMs, { leading: true, trailing: true }),
    [sendView]
  )

  useEffect(() => () => scheduleView.cancel(), [scheduleView])

  // A new connection starts from an empty awareness state, so everything is
  // sent afresh rather than deduplicated against the old one.
  useEffect(() => {
    sent.current = { key: null, activity: null, view: 'none' }
    flush()
  }, [flush])

  useEffect(() => {
    config.current = { canEditCode, canEditBoard, language, sharing }
    flush()
    sendView()
  }, [canEditCode, canEditBoard, language, sharing, flush, sendView])

  /* ---------- following ---------- */

  const stop = useCallback(
    (reason) => {
      if (followingRef.current == null) return false
      const name = leaderName.current
      followingRef.current = null
      leaderName.current = null
      leaderSeen.current = { surface: null, line: null, view: null }
      setFollowing(null)
      flush()
      if (reason) endedRef.current?.(reason, name)
      return true
    },
    [flush]
  )

  /**
   * Moves this person's panes to wherever the leader is, sending each pane only
   * what changed since the last time — a leader who scrolls without changing
   * line does not re-centre anybody's editor.
   *
   * The surface goes first so a follower with the code pane hidden gets it
   * shown before being asked to scroll it.
   */
  const relay = useCallback(
    (leader) => {
      const presence = leader.presence
      const seen = leaderSeen.current

      if (presence?.surface && presence.surface !== seen.surface) {
        seen.surface = presence.surface
        navigator.emit('surface', presence.surface)
      }

      if (presence?.surface === 'code' && presence.line != null && presence.line !== seen.line) {
        seen.line = presence.line
        navigator.emit('code', { line: presence.line })
      }

      if (leader.view) {
        const key = viewKey(leader.view)
        if (key !== seen.view) {
          seen.view = key
          navigator.emit('board', { view: leader.view })
        }
      }
    },
    [navigator]
  )

  useEffect(() => {
    const awareness = provider?.awareness
    if (!awareness) return undefined

    const onChange = () => {
      const states = awareness.getStates()
      const mine = awareness.clientID

      const who = []
      states.forEach((state, clientId) => {
        if (clientId !== mine && state.user && state.presence?.following === mine) {
          who.push({ clientId, name: state.user.name, color: state.user.color })
        }
      })

      const key = who.map((entry) => entry.clientId).join(',')
      if (key !== followersKey.current) {
        followersKey.current = key
        followerCount.current = who.length
        setFollowers(who)
        scheduleView()
      }

      const leaderId = followingRef.current
      if (leaderId == null) return

      const leader = states.get(leaderId)
      if (!leader?.user) {
        stop('left')
        return
      }
      if (!leader.presence?.share) {
        stop('private')
        return
      }

      relay(leader)
    }

    onChange()
    awareness.on('change', onChange)
    return () => awareness.off('change', onChange)
  }, [provider, scheduleView, relay, stop])

  const follow = useCallback(
    (clientId) => {
      const awareness = provider?.awareness
      if (!awareness || clientId === awareness.clientID) return false

      const leader = awareness.getStates().get(clientId)
      if (!leader?.user || !leader.presence?.share) return false

      followingRef.current = clientId
      leaderName.current = leader.user.name ?? null
      leaderSeen.current = { surface: null, line: null, view: null }
      setFollowing(clientId)

      // Said now rather than on the next throttle tick: the leader starts
      // sending a viewport only once it hears it is being followed.
      flush()
      relay(leader)
      return true
    },
    [provider, flush, relay]
  )

  const unfollow = useCallback(() => stop(null), [stop])

  /**
   * A single jump to wherever somebody is, without following them there.
   *
   * Prefers what they are working on over where their pointer happens to be:
   * the line their caret is on, or the shapes they have selected, and only
   * then the pointer itself.
   */
  const focus = useCallback(
    (clientId) => {
      const awareness = provider?.awareness
      if (!awareness) return false

      const state = awareness.getStates().get(clientId)
      const peer = state && { user: state.user, presence: state.presence, cursor: state.cursor }
      if (!canFocus(peer)) return false

      const presence = state.presence
      if (presence?.surface === 'code' && presence.line != null) {
        navigator.emit('surface', 'code')
        navigator.emit('code', { line: presence.line })
        return true
      }

      navigator.emit('surface', 'board')
      navigator.emit('board', {
        point: state.cursor ?? null,
        selected: presence?.selected ?? null,
        view: state.view ?? null,
      })
      return true
    },
    [provider, navigator]
  )

  /* ---------- reporting, from the panes ---------- */

  const reportCode = useCallback(
    ({ line, typed = false } = {}) => {
      const state = local.current
      const now = Date.now()
      state.surface = 'code'
      state.lastInputAt = now
      if (Number.isInteger(line)) state.line = line
      if (typed) {
        state.lastTypedAt = now
        decay()
      }
      schedule()
    },
    [schedule, decay]
  )

  const reportBoard = useCallback(
    ({ selected, drew = false, engaged = false } = {}) => {
      const state = local.current
      const now = Date.now()
      state.lastInputAt = now
      if (engaged || drew) state.surface = 'board'
      if (Array.isArray(selected)) state.selected = selected.slice(0, MAX_SELECTED)
      if (drew) {
        state.lastDrewAt = now
        decay()
      }
      schedule()
    },
    [schedule, decay]
  )

  /**
   * Proof of life for input that changes nothing else — a pointer drifting
   * across the board. Free unless this person had gone idle, in which case it
   * is the thing that brings them back.
   */
  const touch = useCallback(() => {
    local.current.lastInputAt = Date.now()
    if (sent.current.activity === 'idle') schedule()
  }, [schedule])

  const reportView = useCallback(
    (next) => {
      view.current = next
      if (followerCount.current > 0) scheduleView()
    },
    [scheduleView]
  )

  // One object that changes only when following does. Returned fresh each
  // render, it would hand every pane a new dependency on every keystroke of
  // everybody in the room.
  return useMemo(
    () => ({
      navigator,
      following,
      followers,
      follow,
      unfollow,
      focus,
      reportCode,
      reportBoard,
      reportView,
      touch,
    }),
    [navigator, following, followers, follow, unfollow, focus, reportCode, reportBoard, reportView, touch]
  )
}
