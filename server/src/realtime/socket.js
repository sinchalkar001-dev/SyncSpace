import { Server as SocketServer } from 'socket.io'
import { z } from 'zod'
import { verifyToken } from '../services/auth.service.js'
import { canAccess, ensureRoom, recordParticipant } from '../services/room.service.js'
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

  io.use((socket, next) => {
    const payload = verifyToken(socket.handshake.auth?.token)

    if (!payload && !env.ALLOW_ANONYMOUS) {
      next(new Error('Authentication required'))
      return
    }

    const claimed = socket.handshake.auth?.user || {}
    socket.data.user = payload
      ? { id: payload.sub, name: payload.name, anonymous: false }
      : { id: null, name: String(claimed.name || 'Guest').slice(0, 32), anonymous: true }

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

      if (!canAccess(room, socket.data.user.id)) {
        ack?.({ ok: false, error: 'forbidden' })
        return
      }

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
      ack?.({ ok: true, room: room.toPublic() })

      logger.debug({ room: roomId, socket: socket.id }, 'socket joined room')
    })

    socket.on('room:leave', async ({ roomId } = {}) => {
      const target = roomId || socket.data.roomId
      if (!target) return
      await socket.leave(target)
      socket.data.roomId = null
      io.to(target).emit('room:presence', { roomId: target, members: await roster(io, target) })
    })

    socket.on('room:chat', (payload, ack) => {
      const parsed = chatSchema.safeParse(payload)
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' })
        return
      }
      if (socket.data.roomId !== parsed.data.roomId) {
        ack?.({ ok: false, error: 'not_in_room' })
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
