import { useEffect, useRef } from 'react'
import { createRoomSocket } from '../lib/socket.js'

// Room lifecycle rides on Socket.io, which only exists once the backend is up.
// Until then this stays off so the client does not sit in a reconnect loop.
const ENABLED = import.meta.env.VITE_ENABLE_ROOM_SOCKET === 'true'

/** Joins the Socket.io room channel used for presence events, chat and invites. */
export function useRoomSocket(roomId, user) {
  const socketRef = useRef(null)

  useEffect(() => {
    if (!ENABLED || !roomId) return undefined

    const socket = createRoomSocket({ roomId, user })
    socketRef.current = socket

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
