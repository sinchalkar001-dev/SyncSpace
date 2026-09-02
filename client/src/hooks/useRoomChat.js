import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The room's chat, which the server has always broadcast and nothing listened
 * for.
 *
 * Messages are held in memory only, exactly matching what the server does:
 * `room:chat` is broadcast to whoever is connected and never stored, so anyone
 * who joins later starts from an empty transcript. That is the honest shape to
 * build against — pretending otherwise would mean showing history that does
 * not exist.
 */

/** Enough to scroll back through a session without growing without bound. */
const KEEP = 200

export function useRoomChat({ roomId, socketRef, self, open }) {
  const [messages, setMessages] = useState([])
  const [unread, setUnread] = useState(0)

  // Read at delivery time so the socket handler never needs re-registering.
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
    if (open) setUnread(0)
  }, [open])

  // Messages are keyed locally: the server sends no id, and two identical
  // lines a second apart are still two messages.
  const nextKey = useRef(0)

  /** Handler for the socket's `room:chat` event. */
  const receive = useCallback(
    (payload) => {
      if (!payload?.text) return

      nextKey.current += 1
      const mine = Boolean(payload.from?.id) && payload.from.id === self?.id

      setMessages((current) =>
        [...current, { key: nextKey.current, from: payload.from, text: payload.text, at: payload.at, mine }]
          .slice(-KEEP)
      )

      // Your own message is not news, and neither is one you are looking at.
      if (!mine && !openRef.current) setUnread((count) => count + 1)
    },
    [self?.id]
  )

  const send = useCallback(
    (text) => {
      const body = String(text).trim()
      if (!body || !socketRef?.current) return false

      socketRef.current.emit('room:chat', { roomId, text: body })
      return true
    },
    [roomId, socketRef]
  )

  // A room change is a different conversation.
  useEffect(() => {
    setMessages([])
    setUnread(0)
  }, [roomId])

  return { messages, unread, receive, send }
}
