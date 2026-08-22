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
 */
export function useCodeRunner(roomId, displayName) {
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [support, setSupport] = useState(null)
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

      try {
        const payload = await api.run(
          roomId,
          // `as` names a guest in the room's console; a signed-in run is
          // attributed from its token instead and this is ignored.
          { language, code, stdin, runId, as: displayName || undefined },
          inFlight.current.signal
        )
        setResult({ ...payload.run, by: null, at: Date.now() })
      } catch (cause) {
        if (cause?.name === 'AbortError') return
        setError(cause?.message || 'Could not run this')
      } finally {
        setStatus('idle')
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
    () => ({ status, result, error, support, start, receive, clear, blocker, request, requestId }),
    [status, result, error, support, start, receive, clear, blocker, request, requestId]
  )
}
