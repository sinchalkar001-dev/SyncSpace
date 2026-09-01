import { useEffect, useRef } from 'react'
import { createRoomSocket } from '../lib/socket.js'

// On by default now that the backend serves /socket.io. Set the flag to
// 'false' to run the client against a collab-only server.
const ENABLED = import.meta.env.VITE_ENABLE_ROOM_SOCKET !== 'false'

/**
 * Joins the Socket.io room channel used for presence events, chat and invites.
 *
 * The token travels with the connection, exactly as it does on the collab
 * provider. Without it every socket authenticated as an anonymous visitor:
 * a private room refused the join outright, and everyone who signed in was
 * still logged as a guest in the room's visitor list.
 *
 * `handlers` maps an event name to a callback. They are read from a ref at
 * delivery time, so a caller can pass a fresh object every render without
 * tearing down the connection — reconnecting on every keystroke in the room
 * would drop presence and lose messages.
 */
export function useRoomSocket(roomId, user, token, handlers) {
  const socketRef = useRef(null)
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    if (!ENABLED || !roomId) return undefined

    const socket = createRoomSocket({ roomId, user, token })
    socketRef.current = socket

    // One listener for everything: which events matter is the caller's
    // business, and it can change without this effect running again.
    socket.onAny((event, payload) => handlersRef.current?.[event]?.(payload))

    return () => {
      socket.emit('room:leave', { roomId })
      socket.disconnect()
      socketRef.current = null
    }
    // A rename does not need a fresh connection, but signing in or out does:
    // the server reads who you are from the token at handshake time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token])

  return socketRef
}
