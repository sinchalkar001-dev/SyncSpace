import { Router } from 'express'
import { z } from 'zod'
import { optionalAuth, requireAuth } from '../middleware/auth.js'
import { createRateLimiters } from '../middleware/rateLimit.js'
import { validate } from '../middleware/validate.js'
import { refusalFor } from '../middleware/permissions.js'
import { CAPABILITIES, can } from '../permissions.js'
import { getRoom } from '../services/room.service.js'
import {
  createThread,
  deleteMessage,
  editMessage,
  listThreads,
  markSeen,
  replyToThread,
  setThreadStatus,
} from '../services/comment.service.js'
import { ANCHOR_KINDS } from '../models/Comment.js'

/**
 * Comment threads on a room: on its shapes, its board, its code and its files.
 *
 * Mounted beside the files router at /rooms/:roomId/comments. Reading follows
 * the room: whoever can open it can read what is said about it. Writing needs
 * an account — a comment names its author for good — and `comments:write`,
 * which every role from commenter up holds; that role exists so somebody can
 * talk about the work without being able to change it.
 */

const OBJECT_ID = /^[a-f\d]{24}$/i
const BASE64 = /^[A-Za-z0-9+/=]+$/

const text = z.string().trim().min(1, 'a comment cannot be empty').max(4000)
const mentions = z.array(z.string().regex(OBJECT_ID, 'must be a user id')).max(20).optional()

const anchor = z.object({
  kind: z.enum(ANCHOR_KINDS),
  shapeId: z.string().trim().min(1).max(64).optional(),
  offsetX: z.number().min(0).max(1).optional(),
  offsetY: z.number().min(0).max(1).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().min(0).max(1_000_000).optional(),
  height: z.number().min(0).max(1_000_000).optional(),
  start: z.string().max(512).regex(BASE64).optional(),
  end: z.string().max(512).regex(BASE64).optional(),
  line: z.number().int().min(1).max(1_000_000).optional(),
  endLine: z.number().int().min(1).max(1_000_000).optional(),
  startColumn: z.number().int().min(1).max(100_000).optional(),
  endColumn: z.number().int().min(1).max(100_000).optional(),
  snippet: z.string().max(280).optional(),
  fileId: z.string().regex(OBJECT_ID).optional(),
  label: z.string().trim().max(120).optional(),
})

// `ref` is the author's own name for the thread while it was being written,
// echoed in the announcement and never stored. See `createThread`.
const createSchema = z.object({ anchor, text, mentions, ref: z.string().trim().max(64).optional() })
const replySchema = z.object({ text, mentions })
const statusSchema = z.object({ resolved: z.boolean() })

export function createCommentsRouter() {
  const router = Router({ mergeParams: true })
  const { commentLimiter } = createRateLimiters()

  /** The room, if the caller may see it. */
  async function readableRoom(req) {
    const room = await getRoom(req.params.roomId)
    if (!can(room, req.user?.id, CAPABILITIES.ROOM_VIEW)) {
      throw refusalFor(room, req.user?.id, CAPABILITIES.ROOM_VIEW)
    }
    return room
  }

  /** The room, if the caller may comment in it. */
  async function writableRoom(req) {
    const room = await readableRoom(req)
    if (!can(room, req.user.id, CAPABILITIES.COMMENT_WRITE)) {
      throw refusalFor(room, req.user.id, CAPABILITIES.COMMENT_WRITE)
    }
    return room
  }

  router.get('/', optionalAuth, async (req, res, next) => {
    try {
      await readableRoom(req)
      res.json(await listThreads(req.params.roomId, { userId: req.user?.id }))
    } catch (err) {
      next(err)
    }
  })

  router.post('/', requireAuth, commentLimiter, validate(createSchema), async (req, res, next) => {
    try {
      const room = await writableRoom(req)
      const thread = await createThread({
        room,
        user: req.user,
        anchor: req.body.anchor,
        text: req.body.text,
        mentions: req.body.mentions,
        ref: req.body.ref,
      })
      res.status(201).json({ thread })
    } catch (err) {
      next(err)
    }
  })

  /**
   * Marks everything as read for this person.
   *
   * A literal path at the root beside `/:threadId/…` routes of a different
   * shape, so the two can never be read as each other.
   */
  router.post('/seen', requireAuth, async (req, res, next) => {
    try {
      await readableRoom(req)
      res.json(await markSeen({ roomId: req.params.roomId, userId: req.user.id }))
    } catch (err) {
      next(err)
    }
  })

  router.post(
    '/:threadId/replies',
    requireAuth,
    commentLimiter,
    validate(replySchema),
    async (req, res, next) => {
      try {
        const room = await writableRoom(req)
        const thread = await replyToThread({
          room,
          threadId: req.params.threadId,
          user: req.user,
          text: req.body.text,
          mentions: req.body.mentions,
        })
        res.status(201).json({ thread })
      } catch (err) {
        next(err)
      }
    }
  )

  router.patch(
    '/:threadId',
    requireAuth,
    commentLimiter,
    validate(statusSchema),
    async (req, res, next) => {
      try {
        const room = await writableRoom(req)
        const thread = await setThreadStatus({
          room,
          threadId: req.params.threadId,
          user: req.user,
          resolved: req.body.resolved,
        })
        res.json({ thread })
      } catch (err) {
        next(err)
      }
    }
  )

  router.patch(
    '/:threadId/messages/:messageId',
    requireAuth,
    commentLimiter,
    validate(replySchema),
    async (req, res, next) => {
      try {
        const room = await writableRoom(req)
        const thread = await editMessage({
          room,
          threadId: req.params.threadId,
          messageId: req.params.messageId,
          user: req.user,
          text: req.body.text,
          mentions: req.body.mentions,
        })
        res.json({ thread })
      } catch (err) {
        next(err)
      }
    }
  )

  router.delete(
    '/:threadId/messages/:messageId',
    requireAuth,
    commentLimiter,
    async (req, res, next) => {
      try {
        const room = await writableRoom(req)
        const thread = await deleteMessage({
          room,
          threadId: req.params.threadId,
          messageId: req.params.messageId,
          user: req.user,
        })
        res.json({ thread })
      } catch (err) {
        next(err)
      }
    }
  )

  return router
}
