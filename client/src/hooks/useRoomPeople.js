import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { useToast } from '../components/ui/useToast.js'

/**
 * The room roster, plus the three things an owner can do to it.
 *
 * The dashboard dialog and the presence popover in the room both need exactly
 * this — fetch the roster, invite somebody, put somebody out, let them back —
 * and both need every change to be followed by a re-read, because removing a
 * member also clears their visit history and lands them in `blocked`. Doing it
 * in one place keeps the two views from drifting apart.
 *
 * The roster endpoint is for signed-in members only, so `enabled` exists for
 * the guest case: a guest in a public room sees the live list and nothing else,
 * rather than a 403 dressed up as an error.
 */
export function useRoomPeople(roomId, { enabled = true } = {}) {
  const toast = useToast()
  const [state, setState] = useState(enabled ? 'loading' : 'idle')
  const [people, setPeople] = useState(null)
  const [error, setError] = useState(null)

  // Which row is mid-request, so only that button shows a spinner.
  const [pending, setPending] = useState(null)

  const load = useCallback(
    (signal) =>
      api.roomPeople(roomId, signal).then(
        (payload) => {
          setPeople(payload)
          setState('ready')
        },
        (cause) => {
          if (cause?.name === 'AbortError') return
          setError(cause.message)
          setState('error')
        }
      ),
    [roomId]
  )

  useEffect(() => {
    if (!enabled || !roomId) return undefined

    const controller = new AbortController()
    setState('loading')
    setError(null)
    load(controller.signal)

    return () => controller.abort()
  }, [enabled, roomId, load])

  /**
   * One roster change: run it, re-read, and say what happened either way.
   *
   * `describe` may be a function of the answer rather than a fixed line, because
   * an invite cannot know what to say until the server reports whether the
   * email actually went out.
   */
  const act = useCallback(
    async (key, run, describe) => {
      setPending(key)
      try {
        const result = await run()
        await load()

        const said = typeof describe === 'function' ? describe(result) : describe
        const { message, duration } = typeof said === 'string' ? { message: said } : said
        toast.success(message, duration ? { duration } : undefined)
        return true
      } catch (cause) {
        toast.error(cause.message)
        return false
      } finally {
        setPending(null)
      }
    },
    [load, toast]
  )

  /**
   * The invitation itself is an email, so what there is to say afterwards
   * depends on what became of it. Three answers, not two: sent, refused, and
   * still going when the server stopped waiting.
   *
   * Only a refusal makes passing the code on the owner's job, so only a
   * refusal puts the code in the toast. Treating a slow send as a failure
   * would send them chasing their guest over a message already in the inbox.
   */
  const invite = useCallback(
    (email) => {
      const address = String(email).trim()

      return act('invite', () => api.invite(roomId, { email: address }), (payload) => {
        const invited = payload?.invited
        const who = invited?.name || address

        if (invited?.notified) {
          return { message: 'Invited ' + who + ' — the room code is on its way to ' + invited.email }
        }

        if (invited?.notified === null) {
          return { message: 'Invited ' + who + '. The email to ' + invited.email + ' is still sending.' }
        }

        return {
          message:
            'Invited ' + who + ', but the email did not go out. Send them this room code: ' + roomId,
          duration: 12000,
        }
      })
    },
    [act, roomId]
  )

  const remove = useCallback(
    (person) =>
      act(
        person.id,
        () => api.removeMember(roomId, person.id),
        person.name + ' was removed from the room'
      ),
    [act, roomId]
  )

  const allow = useCallback(
    (person) =>
      act(
        person.id,
        () => api.unblockMember(roomId, person.id),
        person.name + ' can open this room again'
      ),
    [act, roomId]
  )

  return { state, people, error, pending, reload: load, invite, remove, allow }
}
