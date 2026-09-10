import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client.js'

const IDLE = { state: 'idle', data: null, error: null }

/**
 * A replay's timeline, its summary, and explanations of single moments.
 *
 * Kept entirely apart from `useReplay`, which serves frames. Nothing here is
 * requested until the session panel is first opened, every request is its own
 * — a slow model call can never sit in front of a frame — and an explanation
 * still in flight is abandoned the moment playback resumes, so a person who
 * changes their mind is not left waiting on an answer about somewhere else.
 *
 * The timeline and the newest summary are fetched together on first open.
 * Both are cheap: the timeline involves no model, and the summary is whatever
 * was last written. Asking the model is only ever a click.
 */
export function useSessionInsights(roomId, { enabled = false } = {}) {
  const [timeline, setTimeline] = useState(IDLE)
  const [summary, setSummary] = useState({ ...IDLE, current: false })
  const [moment, setMoment] = useState({ ...IDLE, seq: null })
  const [ai, setAi] = useState(null)

  const summaryRequest = useRef(null)
  const momentRequest = useRef(null)

  useEffect(() => {
    if (!enabled || !roomId) return undefined

    const controller = new AbortController()
    let cancelled = false

    // A reopened panel keeps what it had while it checks for anything newer.
    setTimeline((current) => (current.data ? current : { state: 'loading', data: null, error: null }))

    api.historyTimeline(roomId, controller.signal).then(
      (payload) => {
        if (!cancelled) setTimeline({ state: 'ready', data: payload.timeline, error: null })
      },
      (failure) => {
        if (cancelled || failure?.name === 'AbortError') return
        setTimeline({ state: 'error', data: null, error: failure?.message || 'The timeline could not be read.' })
      }
    )

    /**
     * The newest summary, applied only if nothing newer has arrived.
     *
     * Opening the panel with "Summarize session" sends this read and the write
     * together. The write can answer first — it is instant whenever the server
     * has the summary cached — and this read, landing after it, would replace
     * the answer just received with whatever existed before it, often nothing.
     * So a summary already on screen is kept, and the read may only refresh
     * whether that same summary is still current.
     */
    api.historySummary(roomId, controller.signal).then(
      (payload) => {
        if (cancelled) return
        setSummary((current) => {
          if (current.state === 'loading') return current
          if (current.data) {
            return payload.summary?.id === current.data.id
              ? { ...current, current: Boolean(payload.current) }
              : current
          }
          return {
            state: payload.summary ? 'ready' : 'idle',
            data: payload.summary,
            error: null,
            current: Boolean(payload.current),
          }
        })
      },
      () => {}
    )

    api.ai(controller.signal).then(
      (status) => {
        if (!cancelled) setAi(status)
      },
      () => {}
    )

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [roomId, enabled])

  useEffect(
    () => () => {
      summaryRequest.current?.abort()
      momentRequest.current?.abort()
    },
    []
  )

  /** Asks for a summary; answered from the server's cache if nothing changed. */
  const summarize = useCallback(async () => {
    summaryRequest.current?.abort()
    const controller = new AbortController()
    summaryRequest.current = controller

    setSummary((current) => ({ ...current, state: 'loading', error: null }))

    try {
      const payload = await api.summarizeHistory(roomId, controller.signal)
      setSummary({ state: 'ready', data: payload.summary, error: null, current: true })
    } catch (failure) {
      if (failure?.name === 'AbortError') return
      // Whatever was there before stays visible under the error.
      setSummary((current) => ({
        ...current,
        state: 'error',
        error: failure?.message || 'The session could not be summarised.',
      }))
    }
  }, [roomId])

  /** Explains the replay position `seq`. A newer request replaces an older one. */
  const explain = useCallback(
    async (seq) => {
      momentRequest.current?.abort()
      const controller = new AbortController()
      momentRequest.current = controller

      setMoment({ state: 'loading', data: null, error: null, seq })

      try {
        const payload = await api.explainMoment(roomId, seq, controller.signal)
        setMoment({ state: 'ready', data: payload.moment, error: null, seq })
      } catch (failure) {
        if (failure?.name === 'AbortError') return
        setMoment({
          state: 'error',
          data: null,
          error: failure?.message || 'This moment could not be explained.',
          seq,
        })
      }
    },
    [roomId]
  )

  /** Drops the explanation, and abandons it if it is still being written. */
  const dismissMoment = useCallback(() => {
    momentRequest.current?.abort()
    setMoment({ ...IDLE, seq: null })
  }, [])

  return useMemo(
    () => ({ timeline, summary, moment, ai, summarize, explain, dismissMoment }),
    [timeline, summary, moment, ai, summarize, explain, dismissMoment]
  )
}
