import { useEffect, useRef } from 'react'
import { createRoomSocket } from '../lib/socket.js'

// On by default now that the backend serves /socket.io. Set the flag to
// 'false' to run the client against a collab-only server.
const ENABLED = import.meta.env.VITE_ENABLE_ROOM_SOCKET !== 'false'

/**
 * Joins the Socket.io room channel used for presence events, chat and invites.
 *
 * `handlers` maps an event name to a callback. They are read from a ref at
 * delivery time, so a caller can pass a fresh object every render without
 * tearing down the connection — reconnecting on every keystroke in the room
 * would drop presence and lose messages.
 */
export function useRoomSocket(roomId, user, handlers) {
  const socketRef = useRef(null)
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    if (!ENABLED || !roomId) return undefined

    const socket = createRoomSocket({ roomId, user })
    socketRef.current = socket

    // One listener for everything: which events matter is the caller's
    // business, and it can change without this effect running again.
    socket.onAny((event, payload) => handlersRef.current?.[event]?.(payload))

    return () => {
      socket.emit('room:leave', { roomId })
      socket.disconnect()
      socketRef.current = null
    }
    // Identity changes do not need a fresh socket connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])

  return socketRef
}
