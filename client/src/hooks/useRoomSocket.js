import { useEffect, useRef } from 'react'
import { createRoomSocket } from '../lib/socket.js'

// On by default now that the backend serves /socket.io. Set the flag to
// 'false' to run the client against a collab-only server.
const ENABLED = import.meta.env.VITE_ENABLE_ROOM_SOCKET !== 'false'

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
