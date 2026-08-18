import { io } from 'socket.io-client'
import { SOCKET_URL } from './env.js'

/**
 * Socket.io carries room lifecycle only (join/leave, chat, invites).
 * Document data travels over the Hocuspocus connection, never here.
 */
export function createRoomSocket({ roomId, user, token }) {
  const socket = io(SOCKET_URL, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token: token || null, user },
    autoConnect: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
  })

  socket.on('connect', () => socket.emit('room:join', { roomId, user }))

  return socket
}
