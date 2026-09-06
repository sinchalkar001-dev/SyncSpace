import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../middleware/validate.js'
import { optionalAuth, requireAuth } from '../middleware/auth.js'
import {
  cancelPendingInvite,
  canAccess,
  createRoom,
  deleteRoom,
  ensureRoom,
  getRoom,
  inviteMember,
  listPeople,
  listRoomsForUser,
  removeMember,
  unblockMember,
  updateRoom,
} from '../services/room.service.js'
import { listTimeline, stateAt } from '../services/replay.service.js'
import {
  applyGeneration,
  getGeneration,
  listGenerations,
  readArchitecture,
  runGeneration,
  withPrevious,
} from '../services/generation.service.js'
import { TARGET_KEYS } from '../services/ai.service.js'
import { runCode } from '../services/runner.service.js'
import { getIo } from '../realtime/registry.js'
import { env } from '../config/env.js'
import { createRateLimiters } from '../middleware/rateLimit.js'
import { badRequest, forbidden } from '../errors.js'

const createSchema = z.object({
  name: z.string().trim().max(80).optional(),
  isPublic: z.boolean().optional(),
})

const generateSchema = z.object({
  targets: z.array(z.enum(TARGET_KEYS)).min(1).max(TARGET_KEYS.length),
  // Free text from the person who drew the diagram, and the one part of the
  // prompt they control directly. Capped because it is forwarded to a model
  // that charges by the token.
  intent: z.string().trim().max(2000).optional(),
})

const applySchema = z.object({
  // The files being accepted. Everything else in the change set is recorded
  // as rejected, so an empty array is a meaningful answer — "none of this" —
  // rather than a malformed one.
  accept: z.array(z.string().regex(/^[0-9a-f]{24}$/i)).max(100),
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

const USER_ID = /^[a-f\d]{24}$/i

/**
 * Who to invite. An id is what another API client has to hand; an email is
 * what the person running the room actually knows about their guest, so both
 * are accepted — but only one at a time, since two answers to "who" would
 * have to be reconciled.
 */
const inviteSchema = z
  .object({
    userId: z.string().regex(USER_ID, 'must be a user id').optional(),
    email: z.string().trim().max(254).email('must be an email address').optional(),
    role: z.enum(['editor', 'viewer']).optional(),
  })
  .refine((value) => Boolean(value.userId) !== Boolean(value.email), {
    message: 'provide either a userId or an email',
  })

/** Path params carry no body to validate, so the id is checked in place. */
function userIdParam(req) {
  if (!USER_ID.test(req.params.userId)) {
    throw badRequest('userId: must be a user id', 'validation_failed')
  }
  return req.params.userId
}

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
  const { inviteLimiter, runLimiter, generateLimiter } = createRateLimiters()

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

  /**
   * Lets somebody in, and tells them so.
   *
   * A private room is invisible from outside, so the invitation email is the
   * whole notification: it carries the room code and a link straight to it.
   * `invited.notified` says whether the relay took the message, because when
   * it did not, passing the code on falls to the owner.
   */
  roomsRouter.post(
    '/:roomId/invite',
    requireAuth,
    inviteLimiter,
    validate(inviteSchema),
    async (req, res, next) => {
      try {
        const { room, invited } = await inviteMember({
          roomId: req.params.roomId,
          actorId: req.user.id,
          userId: req.body.userId,
          email: req.body.email,
          role: req.body.role,
        })
        res.json({ room: room.toPublic(), invited })
      } catch (err) {
        next(err)
      }
    }
  )

  /**
   * Removes someone and keeps them out, which is why it is not simply the
   * inverse of an invite: a public room would otherwise let them straight
   * back in through the link.
   */
  roomsRouter.delete('/:roomId/members/:userId', requireAuth, async (req, res, next) => {
    try {
      const { room, removed } = await removeMember({
        roomId: req.params.roomId,
        actorId: req.user.id,
        userId: userIdParam(req),
      })
      res.json({ room: room.toPublic(), removed })
    } catch (err) {
      next(err)
    }
  })

  /**
   * Withdraws an invitation sent to an address that never signed up.
   *
   * Not the same as removing a member: there is no account to put out and
   * nobody to keep away, so this only stops the address being expected.
   */
  roomsRouter.delete('/:roomId/invites/:email', requireAuth, async (req, res, next) => {
    try {
      const { room, cancelled } = await cancelPendingInvite({
        roomId: req.params.roomId,
        actorId: req.user.id,
        email: req.params.email,
      })
      res.json({ room: room.toPublic(), cancelled })
    } catch (err) {
      next(err)
    }
  })

  /** Undoes a removal. The person still needs an invite to a private room. */
  roomsRouter.delete('/:roomId/blocked/:userId', requireAuth, async (req, res, next) => {
    try {
      const room = await unblockMember({
        roomId: req.params.roomId,
        actorId: req.user.id,
        userId: userIdParam(req),
      })
      res.json({ room: room.toPublic() })
    } catch (err) {
      next(err)
    }
  })

  roomsRouter.get('/:roomId/replay', optionalAuth, async (req, res, next) => {
    try {
      await loadAccessibleRoom(req)
      if (!env.PERSIST_UPDATE_LOG) {
        throw badRequest('Replay is disabled (PERSIST_UPDATE_LOG=false)', 'replay_disabled')
      }
      const timeline = await listTimeline(req.params.roomId, {
        limit: req.query.limit,
        from: req.query.from,
      })
      res.json({ timeline })
    } catch (err) {
      next(err)
    }
  })

  /** Binary Yjs state as of `seq`, ready for Y.applyUpdate on the client. */
  roomsRouter.get('/:roomId/replay/:seq', optionalAuth, async (req, res, next) => {
    try {
      await loadAccessibleRoom(req)
      if (!env.PERSIST_UPDATE_LOG) {
        throw badRequest('Replay is disabled (PERSIST_UPDATE_LOG=false)', 'replay_disabled')
      }
      const { state, applied, from } = await stateAt(req.params.roomId, req.params.seq)

      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('X-Updates-Applied', String(applied))
      // Which checkpoint the fold started from, so the saving is observable
      // rather than merely claimed. 0 means the whole log was folded.
      res.setHeader('X-Checkpoint-Seq', String(from))
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

  /**
   * What the server reads on the whiteboard, before any model is involved.
   *
   * The preview the UI shows, and the reason this feature is not a screenshot
   * pipeline: the person sees the components, the connections and — above all
   * — what could not be read, and gets to fix the diagram before paying for a
   * generation against a misreading of it.
   *
   * `optionalAuth`, like the room read next to it: a guest who can open a
   * public room can see what is drawn on it, because they are looking at it.
   */
  roomsRouter.get('/:roomId/architecture', optionalAuth, async (req, res, next) => {
    try {
      const room = await ensureRoom(req.params.roomId)
      if (!canAccess(room, req.user?.id)) {
        throw forbidden('You do not have access to this room', 'room_forbidden')
      }

      res.json({ architecture: await readArchitecture(req.params.roomId) })
    } catch (err) {
      next(err)
    }
  })

  /**
   * Turns the diagram into a proposed change set.
   *
   * `requireAuth` rather than the `optionalAuth` used for running code: this
   * one spends money on somebody's API key and writes a record that says who
   * asked for it. A guest identity is a name typed into a box, which is not
   * enough to hang either on.
   */
  roomsRouter.post(
    '/:roomId/generate',
    requireAuth,
    generateLimiter,
    validate(generateSchema),
    async (req, res, next) => {
      try {
        const room = await ensureRoom(req.params.roomId)
        if (!canAccess(room, req.user.id)) {
          throw forbidden('You do not have access to this room', 'room_forbidden')
        }

        const generation = await runGeneration({
          roomId: req.params.roomId,
          user: req.user,
          targets: req.body.targets,
          intent: req.body.intent,
        })

        /**
         * Announced to the room, the way a code run is. Someone else's change
         * set appearing in the panel is the point: the diagram was drawn
         * together, so what it produced belongs to everyone looking at it.
         * The summary, not the files — a change set is a large thing to push
         * down a presence channel, and the panel fetches what it needs.
         */
        getIo()
          ?.to(req.params.roomId)
          .emit('ai:generation', {
            roomId: req.params.roomId,
            generation: {
              id: generation.id,
              status: generation.status,
              summary: generation.summary,
              counts: generation.counts,
              targets: generation.targets,
              requestedByName: generation.requestedByName,
              createdAt: generation.createdAt,
            },
          })

        res.status(201).json({ generation })
      } catch (err) {
        next(err)
      }
    }
  )

  /** The room's AI history. Summaries only; the files are a separate read. */
  roomsRouter.get('/:roomId/generations', requireAuth, async (req, res, next) => {
    try {
      const room = await ensureRoom(req.params.roomId)
      if (!canAccess(room, req.user.id)) {
        throw forbidden('You do not have access to this room', 'room_forbidden')
      }

      res.json({ generations: await listGenerations(req.params.roomId, req.query) })
    } catch (err) {
      next(err)
    }
  })

  /** One change set in full, for review. */
  roomsRouter.get('/:roomId/generations/:generationId', requireAuth, async (req, res, next) => {
    try {
      const room = await ensureRoom(req.params.roomId)
      if (!canAccess(room, req.user.id)) {
        throw forbidden('You do not have access to this room', 'room_forbidden')
      }

      const generation = await getGeneration(req.params.roomId, req.params.generationId)
      // Reopened change sets get the same comparison a fresh one has, read
      // against the file as it stands now rather than as it stood then.
      res.json({ generation: await withPrevious(req.params.roomId, generation.toPublic()) })
    } catch (err) {
      next(err)
    }
  })

  /**
   * Accepts some of a change set and turns down the rest.
   *
   * Partial application is the whole shape of this endpoint rather than an
   * option on it: the caller names what it accepts, and anything unnamed is
   * recorded as rejected. Applying writes into the room's files through the
   * upload service, so the same permission rules apply as to any other file.
   */
  roomsRouter.post(
    '/:roomId/generations/:generationId/apply',
    requireAuth,
    validate(applySchema),
    async (req, res, next) => {
      try {
        const room = await ensureRoom(req.params.roomId)
        if (!canAccess(room, req.user.id)) {
          throw forbidden('You do not have access to this room', 'room_forbidden')
        }

        const result = await applyGeneration({
          roomId: req.params.roomId,
          generationId: req.params.generationId,
          user: req.user,
          accept: req.body.accept,
        })

        // The room's files just changed for everybody, not only the person who
        // pressed apply — the files panel is shared.
        getIo()
          ?.to(req.params.roomId)
          .emit('ai:applied', {
            roomId: req.params.roomId,
            generationId: req.params.generationId,
            by: { id: req.user.id, name: req.user.name },
            applied: result.applied,
            rejected: result.rejected,
            failed: result.failed,
          })

        res.json(result)
      } catch (err) {
        next(err)
      }
    }
  )

  return roomsRouter
}
