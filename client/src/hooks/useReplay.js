import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { api } from '../api/client.js'
import { STEP_MS } from '../lib/replay.js'

/**
 * A room's history, positioned anywhere in it.
 *
 * The server has kept an append-only log of every Yjs update since the day it
 * was written, and has answered both `/replay` and `/replay/:seq` all along —
 * nothing ever asked. This is what asks.
 *
 * Two things about Yjs shape the whole design. Updates only ever add, so a
 * frame cannot be produced by rewinding the one before it; and they are
 * commutative, so the state at a point is exactly the fold of everything up to
 * it. That fold is the server's job (`/replay/:seq`), and every position here
 * gets a document of its own built from the answer.
 */

/** The server clamps one response to this, so paging is in these steps. */
const PAGE = 500

/**
 * Where paging stops. A scrubber over more positions than this has pixels
 * finer than its steps, and each one is a round trip; the viewer says when it
 * has stopped rather than pretending the room began here.
 */
const MAX_ENTRIES = 5000

/** Frames held in memory. Bytes, not documents — the documents are transient. */
const CACHE_LIMIT = 200

const EMPTY_FRAME = { index: 0, seq: 0, shapes: [], code: '' }

/** The sequence number a scrubber position stands for. Position 0 predates the log. */
const seqAt = (index, entries) => (index <= 0 ? 0 : (entries[index - 1]?.seq ?? 0))

/**
 * Reads one recorded state into something React can render.
 *
 * The document is built, read and destroyed inside this call: it exists only
 * to interpret the bytes, and keeping it would invite the mistake of applying
 * the next frame on top and wondering why deleted shapes never come back.
 */
function decode(bytes, index, seq) {
  const doc = new Y.Doc()
  try {
    if (bytes?.byteLength) Y.applyUpdate(doc, bytes)
    return {
      index,
      seq,
      shapes: doc.getArray('shapes').toJSON(),
      code: doc.getText('code').toString(),
    }
  } finally {
    doc.destroy()
  }
}

export function useReplay(roomId) {
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')
  const [entries, setEntries] = useState([])
  const [capped, setCapped] = useState(false)
  const [names, setNames] = useState(() => new Map())

  const [index, setIndex] = useState(0)
  const [frame, setFrame] = useState(null)
  const [busy, setBusy] = useState(false)
  const [frameError, setFrameError] = useState('')

  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)

  const cacheRef = useRef(new Map())
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const playingRef = useRef(playing)
  playingRef.current = playing

  const remember = useCallback((seq, bytes) => {
    const cache = cacheRef.current
    cache.delete(seq)
    cache.set(seq, bytes)
    // Map iterates in insertion order, so the oldest key is the first one.
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  }, [])

  /** The whole log, one page at a time, oldest first. */
  useEffect(() => {
    if (!roomId) return undefined

    const controller = new AbortController()
    let cancelled = false

    const read = async () => {
      const all = []
      let from = 0
      let stopped = false

      while (all.length < MAX_ENTRIES) {
        const { timeline } = await api.replayTimeline(
          roomId,
          { limit: PAGE, from },
          controller.signal
        )
        if (!timeline?.length) break
        all.push(...timeline)
        // A short page is the end of the log; a full one may not be.
        if (timeline.length < PAGE) break
        from = timeline[timeline.length - 1].seq
        stopped = all.length >= MAX_ENTRIES
      }

      if (cancelled) return
      setEntries(all)
      setCapped(stopped)
      setIndex(all.length)
      setState('ready')
    }

    setState('loading')
    read().catch((failure) => {
      if (cancelled || failure?.name === 'AbortError') return
      setState(failure?.code === 'replay_disabled' ? 'disabled' : 'error')
      setError(failure?.message || 'This room’s history could not be read.')
    })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [roomId])

  /**
   * Names for the ids in the log. A courtesy, not a requirement: the endpoint
   * that resolves them needs an account, and a guest watching a public room's
   * history simply sees unattributed changes rather than an error.
   */
  useEffect(() => {
    if (!roomId) return undefined

    const controller = new AbortController()
    let cancelled = false

    api
      .roomPeople(roomId, controller.signal)
      .then((people) => {
        if (cancelled) return
        const found = new Map()
        if (people?.owner) found.set(String(people.owner.id), people.owner.name)
        people?.members?.forEach((member) => found.set(String(member.id), member.name))
        people?.participants?.forEach((participant) => {
          if (participant.userId) found.set(String(participant.userId), participant.name)
        })
        setNames(found)
      })
      .catch(() => {})

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [roomId])

  /** The bytes for a position, from memory when they have been seen before. */
  const bytesFor = useCallback(
    async (seq, signal) => {
      const cached = cacheRef.current.get(seq)
      if (cached) return cached
      const bytes = await api.replayStateAt(roomId, seq, signal)
      remember(seq, bytes)
      return bytes
    },
    [roomId, remember]
  )

  /** Whatever position is current, resolved into a frame. */
  useEffect(() => {
    if (state !== 'ready') return undefined

    const seq = seqAt(index, entriesRef.current)

    // Position zero is the document before anything was recorded. The server
    // would answer it correctly; there is just nothing to ask about.
    if (seq === 0) {
      setFrame({ ...EMPTY_FRAME, index })
      setFrameError('')
      setBusy(false)
      return undefined
    }

    const controller = new AbortController()
    let cancelled = false
    setBusy(true)

    bytesFor(seq, controller.signal)
      .then((bytes) => {
        if (cancelled) return
        setFrame(decode(bytes, index, seq))
        setFrameError('')
        setBusy(false)
      })
      .catch((failure) => {
        if (cancelled || failure?.name === 'AbortError') return
        setFrameError(failure?.message || 'That point in the history could not be read.')
        setBusy(false)
        setPlaying(false)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [index, state, bytesFor])

  /**
   * Playback advances only once the frame on screen has arrived, so a slow
   * connection plays slowly instead of queueing steps it cannot keep up with.
   */
  useEffect(() => {
    if (!playing || busy || state !== 'ready') return undefined

    if (index >= entries.length) {
      setPlaying(false)
      return undefined
    }

    const timer = setTimeout(() => setIndex((at) => at + 1), STEP_MS / speed)
    return () => clearTimeout(timer)
  }, [playing, busy, index, entries.length, speed, state])

  /**
   * The next frame is fetched during the current one's dwell time, so a step
   * is usually a cache hit rather than a round trip.
   *
   * Deliberately not aborted when the position moves on: the request is
   * cancelled at exactly the moment its answer becomes useful. It is a GET
   * whose only effect is filling the cache, so an unmount leaves it to settle
   * harmlessly.
   */
  useEffect(() => {
    if (!playing || busy || state !== 'ready') return
    const next = index + 1
    if (next > entries.length) return

    const seq = seqAt(next, entries)
    if (seq === 0 || cacheRef.current.has(seq)) return

    bytesFor(seq).catch(() => {})
  }, [playing, busy, index, entries, state, bytesFor])

  const seek = useCallback((next) => {
    setPlaying(false)
    setIndex(Math.max(0, Math.min(Math.round(Number(next) || 0), entriesRef.current.length)))
  }, [])

  const step = useCallback((delta) => {
    setPlaying(false)
    setIndex((at) => Math.max(0, Math.min(at + delta, entriesRef.current.length)))
  }, [])

  /**
   * The position is moved outside the `playing` updater on purpose. React
   * invokes an updater twice under StrictMode, and a second setState from
   * inside one is a side effect in a place that promises not to have any.
   */
  const toggle = useCallback(() => {
    if (playingRef.current) {
      setPlaying(false)
      return
    }
    // Pressing play at the end is a request to watch it again, not a no-op.
    setIndex((at) => (at >= entriesRef.current.length ? 0 : at))
    setPlaying(true)
  }, [])

  return useMemo(
    () => ({
      state,
      error,
      entries,
      capped,
      names,
      index,
      frame,
      busy,
      frameError,
      playing,
      speed,
      atEnd: index >= entries.length,
      setSpeed,
      seek,
      step,
      toggle,
    }),
    [
      state,
      error,
      entries,
      capped,
      names,
      index,
      frame,
      busy,
      frameError,
      playing,
      speed,
      seek,
      step,
      toggle,
    ]
  )
}
