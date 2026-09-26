import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { api } from '../api/client.js'

/**
 * Runs the room's code on the server and keeps the last result.
 *
 * A run belongs to the room, not to the person who started it: the server
 * broadcasts every result, so everyone watching the same buffer sees the same
 * console. Each request carries an id that comes back in the broadcast, which
 * is how a client recognises its own run and does not show it twice.
 *
 * A run is now also *named* by the server before it finishes, and announced to
 * the room as it moves between states. That is what the Cancel button is built
 * on — without an id for something still running there is nothing to cancel —
 * and it is what makes a slow compile look like progress rather than a hang.
 */

/** The states in which there is still something to stop. */
const LIVE = new Set(['queued', 'running'])

/**
 * How often to ask again while a language is still being set up.
 *
 * A server that runs code in Vercel sandboxes builds their toolchains after it
 * starts, which on a first deploy takes a few minutes. Asking once would leave
 * the Run button off until somebody reloaded; asking every few seconds would
 * be noise for a wait measured in minutes.
 */
export const PENDING_RECHECK_MS = 15000

export function useCodeRunner(roomId, displayName) {
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [support, setSupport] = useState(null)
  /** The run currently in flight anywhere in the room, or null. */
  const [live, setLive] = useState(null)
  /**
   * Which run a cancel was asked for, rather than a flag. A flag had only the
   * end of this person's own run to put it down, so stopping somebody else's
   * program left it up for good, and every later Cancel in the room returned
   * without asking the server.
   */
  const [cancellingId, setCancellingId] = useState(null)
  const cancelling = cancellingId !== null && cancellingId === live?.executionId
  // Bumped by anything that wants a run but does not hold the buffer — the
  // command palette, for one. The editor watches it and starts the run.
  const [requestId, setRequestId] = useState(0)

  const mine = useRef(new Set())
  const inFlight = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    let timer = null
    let last = null

    const pending = (answer) => Boolean(answer?.languages?.some((entry) => entry.pending))

    const ask = () =>
      api
        .runners(controller.signal)
        .then((answer) => {
          last = answer
          setSupport(answer)
          // Asked again only while something is on its way, and never once
          // everything is settled — this is not a heartbeat.
          if (pending(answer)) timer = setTimeout(ask, PENDING_RECHECK_MS)
        })
        .catch(() => {
          if (controller.signal.aborted) return

          // A re-check that fails keeps what the last answer said and tries
          // again: one dropped request should not switch the feature off.
          if (pending(last)) {
            timer = setTimeout(ask, PENDING_RECHECK_MS)
            return
          }

          // Not being able to ask is the same as not being able to run: the
          // button says so rather than failing when someone presses it.
          setSupport({ enabled: false, languages: [] })
        })

    ask()

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [])

  // A run in flight when the room closes should not land on a gone component.
  useEffect(() => () => inFlight.current?.abort(), [])

  const start = useCallback(
    async ({ language, code, stdin = '' }) => {
      if (!roomId || status === 'running') return

      const runId = nanoid(8)
      mine.current.add(runId)
      inFlight.current = new AbortController()

      setStatus('running')
      setError(null)
      // Queued until the server says otherwise. Without this the panel shows
      // nothing at all for however long the queue is, which reads as a click
      // that did not register.
      setLive({ runId, executionId: null, state: 'queued', mine: true })

      try {
        const payload = await api.run(
          roomId,
          // `as` names a guest in the room's console; a signed-in run is
          // attributed from its token instead and this is ignored.
          { language, code, stdin, runId, as: displayName || undefined },
          inFlight.current.signal
        )
        // What was sent is part of the result. Judging a finished run by
        // whatever the input box holds *now* means the moment someone acts on
        // the advice, the advice disappears and the failure it explained is
        // still on screen.
        setResult({ ...payload.run, by: null, at: Date.now(), sentStdin: stdin })
      } catch (cause) {
        if (cause?.name === 'AbortError') return
        setError(cause?.message || 'Could not run this')
      } finally {
        setStatus('idle')
        // Only ours. Somebody else's program may still be running in this
        // room, and blanking their indicator would take the Cancel button
        // away from the owner who might need it.
        setLive((current) => (current && current.mine === false ? current : null))
        inFlight.current = null
      }
    },
    [roomId, status, displayName]
  )

  /** A run somebody else in the room started. */
  const receive = useCallback((payload) => {
    if (!payload?.run) return
    if (payload.runId && mine.current.has(payload.runId)) return
    setResult({ ...payload.run, by: payload.by || null, at: Date.now() })
    setError(null)
  }, [])

  /**
   * A run moving between states, anywhere in the room.
   *
   * Everyone's, not only your own: a program somebody else started is holding
   * the room's slot, and the room owner can stop it. Showing only your own
   * would leave the console blank while the room is plainly busy.
   */
  const receiveState = useCallback((payload) => {
    if (!payload?.executionId) return

    const isMine = Boolean(payload.runId && mine.current.has(payload.runId))

    setLive((current) => {
      if (!LIVE.has(payload.state)) {
        // Only clear the run this message is about; a stale terminal message
        // for an older run must not blank a newer one.
        return current && current.executionId !== payload.executionId ? current : null
      }

      return {
        runId: payload.runId ?? null,
        executionId: payload.executionId,
        state: payload.state,
        by: payload.by ?? null,
        mine: isMine,
      }
    })
  }, [])

  /**
   * Stops whatever is running.
   *
   * The refusal is shown rather than swallowed. Losing the race with a program
   * that was about to end anyway is not a failure — the server answers that
   * with `cancelled: false` and a 200 — so anything that actually throws here
   * is a real refusal, and the first version of this hid one: a guest sending
   * no name was a stranger to their own run, got a 403, and saw a Cancel
   * button that silently did nothing until the timeout.
   */
  const cancel = useCallback(async () => {
    const target = live?.executionId
    if (!roomId || !target || cancelling) return

    setCancellingId(target)
    try {
      await api.cancelRun(roomId, target, displayName || undefined)
    } catch (cause) {
      setCancellingId(null)
      // Except the one genuine race: it is already gone, which is what was
      // wanted anyway.
      if (cause?.code === 'execution_not_found') return
      setError(cause?.message || 'Could not stop this')
    }
  }, [roomId, live, cancelling, displayName])

  const clear = useCallback(() => {
    setResult(null)
    setError(null)
  }, [])

  /** Why a language cannot be run, or null when it can. */
  const blocker = useCallback(
    (language) => {
      if (!support) return 'Checking what this server can run…'
      if (!support.enabled) return 'Running code is switched off on this server'

      const entry = support.languages.find((item) => item.language === language)
      if (!entry) return language + ' can be written and shared here, but not run'
      // The server's own words when it has them: "being installed" and "could
      // not be installed, because…" are both more use than "not installed".
      if (!entry.available) return entry.reason || entry.toolchain + ' is not installed on the server'

      return null
    },
    [support]
  )

  /** Whether a language is on its way rather than missing — the button says "Setting up". */
  const preparing = useCallback(
    (language) =>
      Boolean(support?.languages?.find((item) => item.language === language && !item.available)?.pending),
    [support]
  )

  const request = useCallback(() => setRequestId((value) => value + 1), [])

  // One object identity per actual change: the room passes this straight into
  // a memoised command list and down to the editor as a prop.
  return useMemo(
    () => ({
      status,
      result,
      error,
      support,
      isolation: support?.isolation ?? null,
      live,
      cancelling,
      start,
      cancel,
      receive,
      receiveState,
      clear,
      blocker,
      preparing,
      request,
      requestId,
    }),
    [
      status,
      result,
      error,
      support,
      live,
      cancelling,
      start,
      cancel,
      receive,
      receiveState,
      clear,
      blocker,
      preparing,
      request,
      requestId,
    ]
  )
}
