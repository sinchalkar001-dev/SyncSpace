import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { isVisible, mergeThread, sortThreads, unreadOf } from '../lib/comments.js'

let sequence = 0
const pendingId = (kind) => 'pending-' + kind + '-' + Date.now().toString(36) + '-' + (sequence += 1)

/**
 * A room's comment threads, kept current, with every change shown at once.
 *
 * Every action appears immediately and is undone if the server refuses it. The
 * undo is careful about one thing: it only restores a thread if nothing newer
 * has arrived since. Another person's reply can land over the socket while this
 * person's own request is still in flight, and a rollback that restored the
 * snapshot blindly would erase their reply along with the failed change.
 * Versions decide — a failed change is undone only on the copy it was made to.
 *
 * Announcements from the socket and responses from requests are merged by the
 * same rule, `mergeThread`, which keeps the higher version. So whichever arrives
 * first, the room ends up agreeing.
 */
export function useComments(roomId, { user, onError } = {}) {
  const [threads, setThreads] = useState([])
  const [state, setState] = useState('loading')
  const [error, setError] = useState(null)
  const [seenAt, setSeenAt] = useState(null)
  const [people, setPeople] = useState([])

  const errorRef = useRef(onError)
  useEffect(() => {
    errorRef.current = onError
  }, [onError])

  const fail = useCallback((failure, fallback) => {
    errorRef.current?.(failure?.message || fallback)
  }, [])

  const load = useCallback(
    (signal) => {
      setState('loading')
      return api.comments(roomId, signal).then(
        (payload) => {
          setThreads(payload.threads ?? [])
          setSeenAt(payload.seenAt ?? null)
          setError(null)
          setState('ready')
        },
        (failure) => {
          if (failure?.name === 'AbortError') return
          setError(failure?.message || 'Comments could not be loaded.')
          setState('error')
        }
      )
    },
    [roomId]
  )

  useEffect(() => {
    if (!roomId) return undefined
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [roomId, load])

  /**
   * Who can be mentioned: the room's members and anybody with an account who
   * has opened it. The server checks the same thing again when a message is
   * written; this list is only what the picker offers.
   */
  useEffect(() => {
    if (!roomId || !user?.id) return undefined
    const controller = new AbortController()

    api.roomPeople(roomId, controller.signal).then(
      (roster) => {
        const found = new Map()
        const add = (id, name) => {
          if (id && name && String(id) !== String(user.id)) found.set(String(id), name)
        }
        if (roster?.owner) add(roster.owner.id, roster.owner.name)
        roster?.members?.forEach((member) => add(member.id, member.name))
        roster?.participants?.forEach((participant) => add(participant.userId, participant.name))
        setPeople([...found].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)))
      },
      () => {}
    )

    return () => controller.abort()
  }, [roomId, user?.id])

  /**
   * A thread somebody changed, announced over the room's socket.
   *
   * A new thread carries `ref`, the placeholder id its author's client gave it.
   * The announcement usually beats the response to the request that created
   * it, so on the author's own screen it replaces that placeholder rather than
   * appearing beside it. Everybody else has no thread by that id.
   */
  const receive = useCallback(
    (payload) => {
      if (!payload?.thread) return
      if (payload.roomId && payload.roomId !== roomId) return
      setThreads((current) =>
        mergeThread(
          payload.ref ? current.filter((thread) => thread.id !== payload.ref) : current,
          payload.thread
        )
      )
    },
    [roomId]
  )

  const settle = useCallback((thread) => {
    if (thread) setThreads((current) => mergeThread(current, thread))
  }, [])

  /**
   * Applies `change` to one thread now, and returns how to undo it — an undo
   * that only takes effect if that thread has not moved on in the meantime.
   */
  const optimistic = useCallback((threadId, change) => {
    let before = null
    setThreads((current) =>
      current.map((thread) => {
        if (thread.id !== threadId) return thread
        before = thread
        return change(thread)
      })
    )

    return () =>
      setThreads((current) =>
        current.map((thread) =>
          thread.id === threadId && before && thread.version === before.version ? before : thread
        )
      )
  }, [])

  const create = useCallback(
    async ({ anchor, text, mentions = [] }) => {
      const id = pendingId('thread')
      const now = new Date().toISOString()

      setThreads((current) => [
        {
          id,
          roomId,
          anchor,
          status: 'open',
          pending: true,
          version: 0,
          createdAt: now,
          updatedAt: now,
          createdBy: user?.id,
          createdByName: user?.name,
          createdSeq: 0,
          events: [],
          messages: [
            {
              id: id + '-message',
              author: user?.id,
              authorName: user?.name,
              body: text,
              mentions,
              createdAt: now,
              editedAt: null,
              deleted: false,
              pending: true,
            },
          ],
        },
        ...current,
      ])

      try {
        const { thread } = await api.createComment(roomId, { anchor, text, mentions, ref: id })
        setThreads((current) => mergeThread(current.filter((entry) => entry.id !== id), thread))
        return thread
      } catch (failure) {
        setThreads((current) => current.filter((entry) => entry.id !== id))
        fail(failure, 'Your comment could not be posted.')
        return null
      }
    },
    [roomId, user?.id, user?.name, fail]
  )

  const reply = useCallback(
    async (threadId, { text, mentions = [] }) => {
      const id = pendingId('message')
      const now = new Date().toISOString()

      const undo = optimistic(threadId, (thread) => ({
        ...thread,
        updatedAt: now,
        messages: [
          ...thread.messages,
          {
            id,
            author: user?.id,
            authorName: user?.name,
            body: text,
            mentions,
            createdAt: now,
            editedAt: null,
            deleted: false,
            pending: true,
          },
        ],
      }))

      try {
        settle((await api.replyToComment(roomId, threadId, { text, mentions })).thread)
        return true
      } catch (failure) {
        undo()
        fail(failure, 'Your reply could not be posted.')
        return false
      }
    },
    [roomId, user?.id, user?.name, optimistic, settle, fail]
  )

  const setResolved = useCallback(
    async (threadId, resolved) => {
      const undo = optimistic(threadId, (thread) => ({
        ...thread,
        status: resolved ? 'resolved' : 'open',
        resolvedByName: resolved ? user?.name : null,
      }))

      try {
        settle((await api.resolveComment(roomId, threadId, resolved)).thread)
        return true
      } catch (failure) {
        undo()
        fail(failure, resolved ? 'The thread could not be resolved.' : 'The thread could not be reopened.')
        return false
      }
    },
    [roomId, user?.name, optimistic, settle, fail]
  )

  const edit = useCallback(
    async (threadId, messageId, { text, mentions = [] }) => {
      const now = new Date().toISOString()
      const undo = optimistic(threadId, (thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId ? { ...message, body: text, mentions, editedAt: now } : message
        ),
      }))

      try {
        settle((await api.editComment(roomId, threadId, messageId, { text, mentions })).thread)
        return true
      } catch (failure) {
        undo()
        fail(failure, 'The comment could not be edited.')
        return false
      }
    },
    [roomId, optimistic, settle, fail]
  )

  const remove = useCallback(
    async (threadId, messageId) => {
      const undo = optimistic(threadId, (thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId ? { ...message, body: '', mentions: [], deleted: true } : message
        ),
      }))

      try {
        settle((await api.deleteComment(roomId, threadId, messageId)).thread)
        return true
      } catch (failure) {
        undo()
        fail(failure, 'The comment could not be deleted.')
        return false
      }
    },
    [roomId, optimistic, settle, fail]
  )

  /** Everything is read as of now. Shown at once; told to the server quietly. */
  const markSeen = useCallback(() => {
    setSeenAt(new Date().toISOString())
    if (user?.id) api.commentsSeen(roomId).catch(() => {})
  }, [roomId, user?.id])

  /**
   * Names for ids, for highlighting mentions: everybody the picker offers, and
   * this person too. The picker leaves you out because nobody mentions
   * themselves — but a mention *of* you is the one most worth highlighting.
   */
  const names = useMemo(() => {
    const map = new Map(people.map((person) => [person.id, person.name]))
    if (user?.id && user?.name) map.set(String(user.id), user.name)
    return map
  }, [people, user?.id, user?.name])

  const visible = useMemo(() => sortThreads(threads.filter(isVisible)), [threads])
  const unread = useMemo(() => unreadOf(threads, { userId: user?.id, seenAt }), [threads, user?.id, seenAt])

  return useMemo(
    () => ({
      state,
      error,
      threads: visible,
      all: threads,
      people,
      names,
      seenAt,
      unread,
      reload: load,
      receive,
      create,
      reply,
      setResolved,
      edit,
      remove,
      markSeen,
    }),
    [state, error, visible, threads, people, names, seenAt, unread, load, receive, create, reply, setResolved, edit, remove, markSeen]
  )
}
