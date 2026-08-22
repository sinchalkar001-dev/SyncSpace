import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../middleware/validate.js'
import { optionalAuth, requireAuth } from '../middleware/auth.js'
import {
  canAccess,
  createRoom,
  deleteRoom,
  ensureRoom,
  getRoom,
  inviteMember,
  listPeople,
  listRoomsForUser,
  updateRoom,
} from '../services/room.service.js'
import { listTimeline, stateAt } from '../services/replay.service.js'
import { runCode } from '../services/runner.service.js'
import { getIo } from '../realtime/registry.js'
import { env } from '../config/env.js'
import { createRateLimiters } from '../middleware/rateLimit.js'
import { badRequest, forbidden } from '../errors.js'

const createSchema = z.object({
  name: z.string().trim().max(80).optional(),
  isPublic: z.boolean().optional(),
})

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    isPublic: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.isPublic !== undefined, {
    message: 'provide a name or isPublic',
  })

/**
 * A program and its input. The code cap is well under the body limit, and
 * generous next to anything anyone types into a shared editor.
 */
const runSchema = z.object({
  language: z.string().trim().min(1).max(32),
  code: z.string().max(100000),
  stdin: z.string().max(10000).optional(),
  // Echoed back in the broadcast so a client can recognise its own run and
  // not show the same output twice.
  runId: z.string().max(64).optional(),
  // A guest's display name, so a shared console can say who ran what. Ignored
  // for signed-in callers, whose name comes from their token — exactly how the
  // socket layer treats a claimed name on join.
  as: z.string().trim().max(32).optional(),
})

const inviteSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i, 'must be a user id'),
  role: z.enum(['editor', 'viewer']).optional(),
})

/** Shared guard: the room must exist and be readable by the caller. */
async function loadAccessibleRoom(req) {
  const room = await getRoom(req.params.roomId)
  if (!canAccess(room, req.user?.id)) {
    throw forbidden('You do not have access to this room', 'room_forbidden')
  }
  return room
}

/**
 * The roster is more sensitive than the room itself: an owned room shows it
 * only to its owner and members. Ownerless ad-hoc rooms stay open to any
 * signed-in visitor, since nobody can claim them.
 */
async function loadRosterRoom(req) {
  const room = await getRoom(req.params.roomId)
  const allowed = room.owner ? room.hasMember(req.user.id) : canAccess(room, req.user.id)
  if (!allowed) throw forbidden('You do not have access to this room', 'room_forbidden')
  return room
}

export function createRoomsRouter() {
  const roomsRouter = Router()
  const { inviteLimiter, runLimiter } = createRateLimiters()

  roomsRouter.post('/', requireAuth, validate(createSchema), async (req, res, next) => {
    try {
      const room = await createRoom({
        name: req.body.name,
        ownerId: req.user.id,
        isPublic: req.body.isPublic ?? false,
      })
      res.status(201).json({ room: room.toPublic() })
    } catch (err) {
      next(err)
    }
  })

  roomsRouter.get('/', requireAuth, async (req, res, next) => {
    try {
      const rooms = await listRoomsForUser(req.user.id)
      res.json({ rooms: rooms.map((room) => room.toPublic()) })
    } catch (err) {
      next(err)
    }
  })

  roomsRouter.get('/:roomId', optionalAuth, async (req, res, next) => {
    try {
      const room = await loadAccessibleRoom(req)
      res.json({ room: room.toPublic() })
    } catch (err) {
      next(err)
    }
  })

  roomsRouter.get('/:roomId/people', requireAuth, async (req, res, next) => {
    try {
      await loadRosterRoom(req)
      res.json(await listPeople(req.params.roomId))
    } catch (err) {
      next(err)
    }
  })

  roomsRouter.patch('/:roomId', requireAuth, validate(updateSchema), async (req, res, next) => {
    try {
      const room = await updateRoom({
        roomId: req.params.roomId,
        actorId: req.user.id,
        patch: req.body,
      })
      res.json({ room: room.toPublic() })
    } catch (err) {
      next(err)
    }
  })

  roomsRouter.delete('/:roomId', requireAuth, async (req, res, next) => {
    try {
      res.json(await deleteRoom({ roomId: req.params.roomId, actorId: req.user.id }))
    } catch (err) {
      next(err)
    }
  })

  roomsRouter.post(
    '/:roomId/invite',
    requireAuth,
    inviteLimiter,
    validate(inviteSchema),
    async (req, res, next) => {
      try {
        const room = await inviteMember({
          roomId: req.params.roomId,
          actorId: req.user.id,
          userId: req.body.userId,
          role: req.body.role,
        })
        res.json({ room: room.toPublic() })
      } catch (err) {
        next(err)
      }
    }
  )

  roomsRouter.get('/:roomId/replay', optionalAuth, async (req, res, next) => {
    try {
      await loadAccessibleRoom(req)
      if (!env.PERSIST_UPDATE_LOG) {
        throw badRequest('Replay is disabled (PERSIST_UPDATE_LOG=false)', 'replay_disabled')
      }
      res.json({ timeline: await listTimeline(req.params.roomId, { limit: req.query.limit }) })
    } catch (err) {
      next(err)
    }
  })

  /** Binary Yjs state as of `seq`, ready for Y.applyUpdate on the client. */
  roomsRouter.get('/:roomId/replay/:seq', optionalAuth, async (req, res, next) => {
    try {
      await loadAccessibleRoom(req)
      const { state, applied } = await stateAt(req.params.roomId, req.params.seq)

      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('X-Updates-Applied', String(applied))
      res.send(state)
    } catch (err) {
      next(err)
    }
  })

  /**
   * Runs the code a client sends and answers with what it printed.
   *
   * The code travels in the request rather than being read from the room's
   * document, because the person pressing Run is looking at their own local
   * copy of the buffer. Taking the server's copy could run something a
   * keystroke older, and confusion about which version ran is worse than the
   * few kilobytes.
   */
  roomsRouter.post(
    '/:roomId/run',
    optionalAuth,
    runLimiter,
    validate(runSchema),
    async (req, res, next) => {
      try {
        // ensureRoom, not getRoom: a room typed straight into the address bar
        // exists as a live document before anything is written about it, and
        // "Room not found" on the first Run of a brand new room is nonsense.
        // The socket layer treats a join the same way.
        const room = await ensureRoom(req.params.roomId)
        if (!canAccess(room, req.user?.id)) {
          throw forbidden('You do not have access to this room', 'room_forbidden')
        }

        const run = await runCode({
          language: req.body.language,
          code: req.body.code,
          stdin: req.body.stdin,
        })

        const by = req.user
          ? { id: req.user.id, name: req.user.name }
          : req.body.as
            ? { id: null, name: req.body.as }
            : null

        // Everyone in the room sees the result, not only whoever pressed Run:
        // a shared buffer with a private console would leave people guessing
        // why the code they are looking at just changed.
        getIo()
          ?.to(req.params.roomId)
          .emit('code:run', {
            roomId: req.params.roomId,
            runId: req.body.runId ?? null,
            by,
            run,
          })

        res.json({ run })
      } catch (err) {
        next(err)
      }
    }
  )

  return roomsRouter
}
