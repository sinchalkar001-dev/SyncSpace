import { useCallback, useEffect, useRef, useState } from 'react'
import { api, streamCopilot } from '../api/client.js'
import { applyPatch } from '../lib/textPatch.js'

/**
 * The state behind the copilot panel.
 *
 * Four things move independently and are kept apart deliberately: what this
 * deployment can do, the answer currently arriving, the room's history of
 * answers, and which files of a change set are ticked. Folding them together
 * would mean re-asking what the server can do every time somebody ticks a
 * checkbox, and losing a half-streamed answer whenever the history refreshed.
 *
 * The streaming is the part worth reading. An answer arrives as prose in
 * pieces followed by one structured result, and a stream that ends without
 * that result is a failure whether or not an error frame arrived — a dropped
 * connection produces neither. So the run is only considered finished when the
 * result lands, and everything else is treated as the answer not having
 * happened.
 */

const EMPTY = Object.freeze({ state: 'idle', text: '', run: null, error: null, action: null, sources: [] })

/** Everything still undecided in a change set. */
const undecided = (run) => (run?.files ?? []).filter((file) => file.status === 'proposed')

export function useCopilot(roomId, { enabled = true, onError } = {}) {
  const [catalogue, setCatalogue] = useState({ state: 'loading', data: null, error: null })
  const [current, setCurrent] = useState(EMPTY)
  const [history, setHistory] = useState([])
  const [selected, setSelected] = useState(() => new Set())
  const [busy, setBusy] = useState(null)

  /**
   * An answer can take half a minute and the panel can be closed in that time.
   * The request is left to finish — it is already being paid for and the run
   * is recorded either way — but nothing is set on an unmounted hook.
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** The stream in flight, so a second question can stop the first. */
  const inflight = useRef(null)
  useEffect(() => () => inflight.current?.abort(), [])

  /** What this deployment can do. Asked once; it does not change underneath. */
  useEffect(() => {
    if (!enabled || !roomId) return undefined
    const controller = new AbortController()

    api.copilot(roomId, controller.signal).then(
      (data) => alive.current && setCatalogue({ state: 'ready', data, error: null }),
      (cause) => {
        if (cause?.name === 'AbortError') return
        // Failing to ask is not the same as the feature being off, and the
        // panel says which of the two happened.
        alive.current && setCatalogue({ state: 'error', data: null, error: cause.message })
      }
    )

    return () => controller.abort()
  }, [enabled, roomId])

  const loadHistory = useCallback(
    async (signal) => {
      try {
        const payload = await api.copilotRuns(roomId, signal)
        if (alive.current) setHistory(payload.runs)
      } catch (cause) {
        // The history is context, not the feature. Failing to load it should
        // not stop somebody asking a question.
        if (cause?.name !== 'AbortError') setHistory([])
      }
    },
    [roomId]
  )

  useEffect(() => {
    if (!enabled || !roomId) return undefined
    const controller = new AbortController()
    loadHistory(controller.signal)
    return () => controller.abort()
  }, [enabled, roomId, loadHistory])

  /** Opens an answer for review and ticks everything still undecided. */
  const adopt = useCallback((run) => {
    setCurrent({
      state: 'done',
      text: run.answer ?? '',
      run,
      error: null,
      action: run.actionId,
      sources: run.sources ?? [],
    })
    setSelected(new Set(undecided(run).map((file) => file.id)))
  }, [])

  /**
   * Runs an action and reads the answer as it arrives.
   *
   * The result frame is what counts as success. Everything before it is a
   * partial answer that might never be completed, which is why `state` stays
   * `streaming` until it lands and why a stream that simply stops is reported
   * as a failure.
   */
  const ask = useCallback(
    async (input) => {
      inflight.current?.abort()
      const controller = new AbortController()
      inflight.current = controller

      setSelected(new Set())
      setCurrent({
        state: 'streaming',
        text: '',
        run: null,
        error: null,
        action: input.action,
        sources: [],
      })

      let finished = null
      let failure = null

      try {
        await streamCopilot(roomId, input, {
          signal: controller.signal,
          onEvent: (event, payload) => {
            if (!alive.current) return

            if (event === 'sources') {
              setCurrent((state) => ({ ...state, sources: payload.sources ?? [] }))
              return
            }

            if (event === 'delta') {
              setCurrent((state) => ({ ...state, text: state.text + (payload.text ?? '') }))
              return
            }

            if (event === 'result') {
              finished = payload.run
              return
            }

            if (event === 'error') {
              failure = payload.message ?? 'The copilot could not answer.'
            }
          },
        })
      } catch (cause) {
        // Aborting is this hook's own doing — a second question, or the panel
        // closing — and is not something to report as a failure.
        if (cause?.name === 'AbortError') return null
        failure = cause.message
      } finally {
        if (inflight.current === controller) inflight.current = null
      }

      if (!alive.current) return null

      if (finished) {
        adopt(finished)
        loadHistory()
        return finished
      }

      // No result frame. Either an error frame said why, or the stream simply
      // stopped — which is the same outcome and must not look like success.
      const message = failure ?? 'The answer stopped before it was finished.'
      setCurrent((state) => ({ ...state, state: 'error', error: message }))
      onError?.(message)
      loadHistory()
      return null
    },
    [roomId, adopt, loadHistory, onError]
  )

  /** Stops an answer that is still arriving. */
  const stop = useCallback(() => {
    inflight.current?.abort()
    inflight.current = null
    setCurrent((state) =>
      state.state === 'streaming'
        ? { ...state, state: 'error', error: 'You stopped this answer.' }
        : state
    )
  }, [])

  const open = useCallback(
    async (runId) => {
      setBusy('open')
      try {
        const payload = await api.copilotRun(roomId, runId)
        if (alive.current) adopt(payload.run)
      } catch (cause) {
        if (alive.current) onError?.(cause.message)
      } finally {
        if (alive.current) setBusy(null)
      }
    },
    [roomId, adopt, onError]
  )

  const toggle = useCallback((fileId) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }, [])

  const setAll = useCallback(
    (on) =>
      setSelected(on ? new Set(undecided(current.run).map((file) => file.id)) : new Set()),
    [current.run]
  )

  /**
   * Applies what is ticked, and records the rest as turned down.
   *
   * Allowed with nothing ticked on purpose: "none of this" is a decision, and
   * a change set left with none is worse than either answer, because nothing
   * afterwards can tell "not looked at" from "looked at and declined".
   */
  const applyFiles = useCallback(async () => {
    const run = current.run
    if (!run) return null

    setBusy('apply')
    try {
      const result = await api.applyCopilotFiles(roomId, run.id, [...selected])
      if (!alive.current) return null
      setCurrent((state) => ({ ...state, run: result.run }))
      setSelected(new Set(undecided(result.run).map((file) => file.id)))
      loadHistory()
      return result
    } catch (cause) {
      if (alive.current) onError?.(cause.message)
      return null
    } finally {
      if (alive.current) setBusy(null)
    }
  }, [roomId, current.run, selected, loadHistory, onError])

  /**
   * Applies a proposed change to the shared buffer, or explains why not.
   *
   * The write happens here rather than on the server because the buffer is a
   * Yjs document: applied in one transaction with an origin, it undoes as one
   * step and reaches everybody else as an ordinary edit by the person who
   * accepted it. `applyPatch` refuses outright if the buffer has moved since
   * the model read it, and that refusal is recorded as `stale` — a real
   * outcome, and the one this whole path exists for.
   */
  const applyCode = useCallback(
    async (yText) => {
      const run = current.run
      if (!run?.patch) return null

      setBusy('patch')
      try {
        const { applied, reason } = applyPatch(yText, run.patch)
        const outcome = applied ? 'applied' : reason === 'stale' ? 'stale' : 'rejected'

        const result = await api.recordCopilotPatch(roomId, run.id, outcome)
        if (!alive.current) return null

        setCurrent((state) => ({ ...state, run: result.run }))
        loadHistory()

        if (!applied) {
          onError?.(
            reason === 'stale'
              ? 'The code changed while the copilot was thinking, so this was not applied. Ask again to work from the current code.'
              : 'That change is already what the buffer says.'
          )
        }

        return { applied, reason }
      } catch (cause) {
        if (alive.current) onError?.(cause.message)
        return null
      } finally {
        if (alive.current) setBusy(null)
      }
    },
    [roomId, current.run, loadHistory, onError]
  )

  /** Turns a proposed change down without touching the buffer. */
  const rejectCode = useCallback(async () => {
    const run = current.run
    if (!run?.patch) return null

    setBusy('patch')
    try {
      const result = await api.recordCopilotPatch(roomId, run.id, 'rejected')
      if (alive.current) setCurrent((state) => ({ ...state, run: result.run }))
      loadHistory()
      return result
    } catch (cause) {
      if (alive.current) onError?.(cause.message)
      return null
    } finally {
      if (alive.current) setBusy(null)
    }
  }, [roomId, current.run, loadHistory, onError])

  const clear = useCallback(() => {
    inflight.current?.abort()
    inflight.current = null
    setCurrent(EMPTY)
    setSelected(new Set())
  }, [])

  return {
    catalogue,
    current,
    history,
    selected,
    busy,
    ask,
    stop,
    open,
    toggle,
    setAll,
    applyFiles,
    applyCode,
    rejectCode,
    clear,
    /** Told by the socket that somebody else in the room asked something. */
    noteRemote: loadHistory,
  }
}
