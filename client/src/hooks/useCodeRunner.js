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

export function useCodeRunner(roomId, displayName) {
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [support, setSupport] = useState(null)
  /** The run currently in flight anywhere in the room, or null. */
  const [live, setLive] = useState(null)
  const [cancelling, setCancelling] = useState(false)
  // Bumped by anything that wants a run but does not hold the buffer — the
  // command palette, for one. The editor watches it and starts the run.
  const [requestId, setRequestId] = useState(0)

  const mine = useRef(new Set())
  const inFlight = useRef(null)

  useEffect(() => {
    const controller = new AbortController()

    api
      .runners(controller.signal)
      .then(setSupport)
      // Not being able to ask is the same as not being able to run: the button
      // says so rather than failing when someone presses it.
      .catch(() => setSupport({ enabled: false, languages: [] }))

    return () => controller.abort()
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
      setCancelling(false)
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
        setCancelling(false)
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
   * Failure is deliberately quiet. The common reason is that the program
   * finished half a second ago, and an error toast for losing that race would
   * be noise about nothing.
   */
  const cancel = useCallback(async () => {
    const target = live?.executionId
    if (!roomId || !target || cancelling) return

    setCancelling(true)
    try {
      await api.cancelRun(roomId, target)
    } catch {
      setCancelling(false)
    }
  }, [roomId, live, cancelling])

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
      if (!entry.available) return entry.toolchain + ' is not installed on the server'

      return null
    },
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
      request,
      requestId,
    ]
  )
}
