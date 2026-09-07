import { io } from 'socket.io-client'
import { SOCKET_URL } from './env.js'

/**
 * Socket.io carries room lifecycle only (join/leave, chat, invites).
 * Document data travels over the Hocuspocus connection, never here.
 */
export function createRoomSocket({ roomId, user, token, onJoined }) {
  const socket = io(SOCKET_URL, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token: token || null, user },
    autoConnect: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
  })

  /**
   * The join answers with what this person may do in the room.
   *
   * It has to come from here rather than from `GET /rooms/:roomId`, which
   * answers 404 until something writes the record — a room typed into the
   * address bar has no capabilities to report over REST, and the interface
   * would disable everything in a room anyone may edit. The socket has just
   * ensured the room exists, so this is the first moment the answer is real.
   *
   * Re-run on every reconnect, which is also when a demotion takes effect:
   * changing somebody's role closes their connections, and the answer they
   * get on the way back in is the new one.
   */
  socket.on('connect', () =>
    socket.emit('room:join', { roomId, user }, (ack) => {
      if (ack?.ok) onJoined?.(ack)
    })
  )

  return socket
}
