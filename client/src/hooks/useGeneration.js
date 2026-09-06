import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'

/**
 * The state behind "Generate from whiteboard".
 *
 * Four things move independently and are kept apart on purpose: whether the
 * server can generate at all, what it reads on the board, the change set being
 * reviewed, and which of its files are ticked. Folding them into one status
 * would mean re-reading the diagram every time somebody ticks a checkbox, and
 * losing a change set the moment the availability check refreshed.
 */

/** Everything selectable in a change set — every file that is still undecided. */
const undecided = (generation) =>
  (generation?.files ?? []).filter((file) => file.status === 'proposed')

export function useGeneration(roomId, { enabled = true } = {}) {
  const [availability, setAvailability] = useState({ state: 'loading', ai: null })
  const [architecture, setArchitecture] = useState({ state: 'idle', graph: null, error: null })
  const [generation, setGeneration] = useState(null)
  const [history, setHistory] = useState([])
  const [selected, setSelected] = useState(() => new Set())
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  /**
   * A generation can take a minute, and the panel can be closed in that time.
   * The request is left running — it is already being paid for, and the record
   * is kept server-side either way — but nothing is set on an unmounted hook.
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** Whether this deployment can generate. Asked once; it cannot change. */
  useEffect(() => {
    if (!enabled) return undefined
    const controller = new AbortController()

    api.ai(controller.signal).then(
      (ai) => alive.current && setAvailability({ state: 'ready', ai }),
      (cause) => {
        if (cause?.name === 'AbortError') return
        // A failure to ask is not a failure to be available; the panel says
        // it could not check rather than claiming the feature is off.
        alive.current && setAvailability({ state: 'error', ai: null, error: cause.message })
      }
    )

    return () => controller.abort()
  }, [enabled])

  const readArchitecture = useCallback(
    async (signal) => {
      setArchitecture((current) => ({ ...current, state: 'loading', error: null }))
      try {
        const payload = await api.architecture(roomId, signal)
        if (!alive.current) return null
        setArchitecture({ state: 'ready', graph: payload.architecture, error: null })
        return payload.architecture
      } catch (cause) {
        if (cause?.name === 'AbortError') return null
        if (alive.current) {
          setArchitecture({ state: 'error', graph: null, error: cause.message })
        }
        return null
      }
    },
    [roomId]
  )

  /** Re-read the board whenever the panel opens; it has been drawn on since. */
  useEffect(() => {
    if (!enabled || !roomId) return undefined
    const controller = new AbortController()
    readArchitecture(controller.signal)
    return () => controller.abort()
  }, [enabled, roomId, readArchitecture])

  const loadHistory = useCallback(
    async (signal) => {
      try {
        const payload = await api.generations(roomId, signal)
        if (alive.current) setHistory(payload.generations)
      } catch (cause) {
        // The history is context, not the feature. Failing to load it should
        // not stop somebody generating.
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

  /** Opens a change set and starts with everything ticked. */
  const adopt = useCallback((next) => {
    setGeneration(next)
    setSelected(new Set(undecided(next).map((file) => file.id)))
  }, [])

  const generate = useCallback(
    async ({ targets, intent }) => {
      setBusy('generate')
      setError(null)
      try {
        const payload = await api.generate(roomId, { targets, intent: intent || undefined })
        if (!alive.current) return null
        adopt(payload.generation)
        loadHistory()
        return payload.generation
      } catch (cause) {
        if (alive.current) setError(cause.message)
        // Recorded server-side even when it fails, so the history is worth
        // refreshing: the failure belongs in the room's timeline.
        loadHistory()
        return null
      } finally {
        if (alive.current) setBusy(null)
      }
    },
    [roomId, adopt, loadHistory]
  )

  const open = useCallback(
    async (generationId) => {
      setBusy('open')
      setError(null)
      try {
        const payload = await api.generation(roomId, generationId)
        if (alive.current) adopt(payload.generation)
      } catch (cause) {
        if (alive.current) setError(cause.message)
      } finally {
        if (alive.current) setBusy(null)
      }
    },
    [roomId, adopt]
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
    (on) => {
      setSelected(on ? new Set(undecided(generation).map((file) => file.id)) : new Set())
    },
    [generation]
  )

  /**
   * Applies what is ticked and records the rest as rejected.
   *
   * Deliberately allowed with nothing ticked: "none of this" is a decision,
   * and the server records it as one. A change set left with no decision is
   * worse than either answer.
   */
  const apply = useCallback(async () => {
    if (!generation) return null
    setBusy('apply')
    setError(null)
    try {
      const result = await api.applyGeneration(roomId, generation.id, [...selected])
      if (!alive.current) return null
      setGeneration(result.generation)
      setSelected(new Set(undecided(result.generation).map((file) => file.id)))
      loadHistory()
      return result
    } catch (cause) {
      if (alive.current) setError(cause.message)
      return null
    } finally {
      if (alive.current) setBusy(null)
    }
  }, [roomId, generation, selected, loadHistory])

  const close = useCallback(() => {
    setGeneration(null)
    setSelected(new Set())
    setError(null)
  }, [])

  return {
    availability,
    architecture,
    refreshArchitecture: () => readArchitecture(),
    generation,
    history,
    selected,
    busy,
    error,
    generate,
    open,
    toggle,
    setAll,
    apply,
    close,
    /** Told by the socket that somebody else in the room generated something. */
    noteRemote: loadHistory,
  }
}
