import { randomUUID } from 'node:crypto'
import { Server as SocketServer } from 'socket.io'
import { z } from 'zod'
import { authenticate } from '../services/auth.service.js'
import { ensureRoom, recordParticipant } from '../services/room.service.js'
import { CAPABILITIES, can, describeAccess, roleFor } from '../permissions.js'
import { env } from '../config/env.js'
import { isAllowedOrigin } from '../config/cors.js'
import { logger } from '../config/logger.js'

const joinSchema = z.object({
  roomId: z.string().min(1).max(64),
  user: z
    .object({
      id: z.string().max(64).optional(),
      name: z.string().max(32).optional(),
      color: z.string().max(16).optional(),
    })
    .optional(),
})

const chatSchema = z.object({
  roomId: z.string().min(1).max(64),
  text: z.string().trim().min(1).max(2000),
})


/**
 * The account behind a socket, or null for a guest.
 *
 * A guest is given a random id so presence can tell two of them apart, and
 * that id must never be mistaken for an account: passing it to the permission
 * model would make a guest look like a member who simply is not in the list,
 * and quietly grant them everything the room gives to signed-in strangers.
 */
const actorOf = (socket) => (socket.data.user?.anonymous ? null : socket.data.user?.id ?? null)

/** Everyone currently in a Socket.io room, as plain objects. */
async function roster(io, roomId) {
  const sockets = await io.in(roomId).fetchSockets()
  return sockets.map((socket) => ({
    socketId: socket.id,
    user: socket.data.user,
  }))
}

/**
 * Room lifecycle only: join, leave, chat. Document data never travels here —
 * that is Hocuspocus's job on /collab.
 */
export function createSocketServer(httpServer) {
  const io = new SocketServer(httpServer, {
    path: '/socket.io',
    cors: {
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
      credentials: true,
    },
  })

  io.use(async (socket, next) => {
    let user
    let revoked
    try {
      // Asks the account whether this session is still current, not only
      // whether the token is well formed — the same check the REST guards and
      // the collab handshake make. Without it a token killed by a password
      // change could still open presence and chat.
      ;({ user, revoked } = await authenticate(socket.handshake.auth?.token))
    } catch (error) {
      // A database failure must not silently admit the connection as a guest.
      logger.warn({ err: error }, 'could not authenticate a socket connection')
      next(new Error('Authentication unavailable'))
      return
    }

    // Refused rather than demoted, for the same reason as the collab
    // handshake: reappearing as "Guest" is harder to understand than being
    // told the session ended.
    if (revoked) {
      next(new Error('Your session ended — sign in again'))
      return
    }

    if (!user && !env.ALLOW_ANONYMOUS) {
      next(new Error('Authentication required'))
      return
    }

    const claimed = socket.handshake.auth?.user || {}
    socket.data.user = user
      ? { id: user.id, name: user.name, anonymous: false }
      : { id: randomUUID(), name: String(claimed.name || 'Guest').slice(0, 32), anonymous: true }

    /**
     * Which session this connection belongs to, so signing out one device can
     * close exactly its connections rather than all of the account's.
     *
     * Kept beside `socket.data.user` rather than inside it on purpose: that
     * object is broadcast to the whole room as presence, and an internal
     * identifier has no business travelling to everyone else in it.
     */
    socket.data.sessionId = user?.sessionId ?? null

    next()
  })

  io.on('connection', (socket) => {
    socket.on('room:join', async (payload, ack) => {
      const parsed = joinSchema.safeParse(payload)
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' })
        return
      }

      const { roomId } = parsed.data
      const room = await ensureRoom(roomId)

      if (!can(room, actorOf(socket), CAPABILITIES.ROOM_VIEW)) {
        ack?.({ ok: false, error: 'forbidden' })
        return
      }

      // Kept so presence can show what each person may do, and so the client
      // knows its own standing without a second request.
      socket.data.role = roleFor(room, actorOf(socket))

      // A guest may pick a display name when joining. An authenticated socket
      // always keeps the name from its token, so nobody can spoof an identity.
      if (socket.data.user.anonymous && parsed.data.user) {
        socket.data.user = {
          ...socket.data.user,
          name: String(parsed.data.user.name || socket.data.user.name).slice(0, 32),
          color: parsed.data.user.color || socket.data.user.color || null,
        }
      }

      socket.data.roomId = roomId
      await socket.join(roomId)
      await recordParticipant({ roomId, user: socket.data.user })

      socket.to(roomId).emit('room:joined', { user: socket.data.user, socketId: socket.id })
      io.to(roomId).emit('room:presence', { roomId, members: await roster(io, roomId) })
      /**
       * The join carries what this person may do, and it is the only place
       * that can for an ad-hoc room: `GET /rooms/:roomId` answers 404 until
       * something writes the record, so a room typed into the address bar has
       * no capabilities to report over REST. The socket has already ensured
       * the room exists, which is exactly the moment the answer becomes real.
       */
      ack?.({ ok: true, room: room.toPublic(), access: describeAccess(room, actorOf(socket)) })

      logger.debug({ room: roomId, socket: socket.id }, 'socket joined room')
    })

    socket.on('room:leave', async ({ roomId } = {}) => {
      const target = roomId || socket.data.roomId
      if (!target) return
      await socket.leave(target)
      socket.data.roomId = null
      io.to(target).emit('room:presence', { roomId: target, members: await roster(io, target) })
    })

    socket.on('room:chat', async (payload, ack) => {
      const parsed = chatSchema.safeParse(payload)
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' })
        return
      }
      if (socket.data.roomId !== parsed.data.roomId) {
        ack?.({ ok: false, error: 'not_in_room' })
        return
      }

      /**
       * Asked again here rather than trusted from the join.
       *
       * A connection can outlive the permission that opened it — somebody
       * demoted to viewer mid-session still holds an open socket, and a role
       * checked once at join would let them keep talking for as long as they
       * stay connected. One indexed read per message is the price of the
       * answer being current.
       */
      const room = await ensureRoom(parsed.data.roomId)

      if (!can(room, actorOf(socket), CAPABILITIES.CHAT_SEND)) {
        ack?.({ ok: false, error: 'permission_denied', message: 'You cannot send messages in this room' })
        return
      }

      io.to(parsed.data.roomId).emit('room:chat', {
        from: socket.data.user,
        text: parsed.data.text,
        at: new Date().toISOString(),
      })
      ack?.({ ok: true })
    })

    socket.on('disconnect', async () => {
      const roomId = socket.data.roomId
      if (!roomId) return
      io.to(roomId).emit('room:presence', { roomId, members: await roster(io, roomId) })
    })
  })

  return io
}
