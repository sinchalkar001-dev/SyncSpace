import { Router } from 'express'
import { z } from 'zod'
import { optionalAuth, requireAuth } from '../middleware/auth.js'
import { createRateLimiters } from '../middleware/rateLimit.js'
import { validate } from '../middleware/validate.js'
import { refusalFor } from '../middleware/permissions.js'
import { CAPABILITIES, can } from '../permissions.js'
import { getRoom } from '../services/room.service.js'
import { Execution } from '../models/Execution.js'
import { aiStatus } from '../services/ai.service.js'
import { CONTEXTS, describeActions } from '../services/copilot/actions.js'
import {
  getCopilotRun,
  listCopilotRuns,
  runCopilotAction,
} from '../services/copilot/run.js'
import { applyCopilotFiles, recordPatchOutcome } from '../services/copilot/apply.js'
import { logger } from '../config/logger.js'

/**
 * The copilot, as five routes rather than twenty-three.
 *
 * Every action goes through `POST /runs` carrying its id. That is the point of
 * the registry: a new capability adds an entry to it and nothing here changes,
 * so there is exactly one place where the permission is checked, one place the
 * rate limit applies, and no route that somebody can add later having
 * forgotten either.
 */

const OBJECT_ID = /^[a-f\d]{24}$/i

/**
 * What a request may carry: coordinates, never material.
 *
 * A line range, a point in the history, a run id — things the server resolves
 * against its own copy of the room. `note` is the one piece of free text, and
 * it is what the person typed, capped because it is forwarded to a model that
 * charges by the token.
 */
const runSchema = z.object({
  action: z.string().trim().min(1).max(60),
  startLine: z.number().int().min(1).max(1_000_000).optional(),
  endLine: z.number().int().min(1).max(1_000_000).optional(),
  seq: z.number().int().min(1).optional(),
  fromSeq: z.number().int().min(1).optional(),
  toSeq: z.number().int().min(1).optional(),
  executionId: z.string().trim().max(64).optional(),
  note: z.string().trim().max(2000).optional(),
})

const applySchema = z.object({
  accept: z.array(z.string().regex(OBJECT_ID)).max(100),
})

/**
 * What the client says happened to a proposed buffer change.
 *
 * `stale` is not a failure — it is the buffer having moved while the model was
 * thinking, which is the case this whole path exists to handle.
 */
const patchSchema = z.object({
  outcome: z.enum(['applied', 'rejected', 'stale']),
})

export function createCopilotRouter() {
  const router = Router({ mergeParams: true })
  const { copilotLimiter } = createRateLimiters()

  async function readableRoom(req) {
    const room = await getRoom(req.params.roomId)
    if (!can(room, req.user?.id, CAPABILITIES.ROOM_VIEW)) {
      throw refusalFor(room, req.user?.id, CAPABILITIES.ROOM_VIEW)
    }
    return room
  }

  /**
   * What the copilot can do here, and whether this person may ask.
   *
   * Answered before anything is offered, like `/runners` and `/ai`: an
   * interface that knows the feature is off can say so where somebody would
   * look for it, rather than presenting twenty-three buttons that all fail.
   */
  router.get('/', optionalAuth, async (req, res, next) => {
    try {
      const room = await readableRoom(req)
      const status = aiStatus()

      /**
       * How many runs this room has, so the interface can tell "nothing has
       * ever run here" from "nothing has run since you opened the tab".
       * Without it, reloading a room full of failed runs would present every
       * execution action as unavailable.
       */
      const runs = await Execution.countDocuments({ roomId: req.params.roomId })

      res.json({
        ...status,
        runs,
        allowed: can(room, req.user?.id, CAPABILITIES.COPILOT_USE),
        reason: status.enabled
          ? can(room, req.user?.id, CAPABILITIES.COPILOT_USE)
            ? null
            : req.user
              ? 'Your role in this room does not include the copilot.'
              : 'Sign in to use the copilot in this room.'
          : status.reason,
        contexts: CONTEXTS,
        actions: describeActions(),
      })
    } catch (err) {
      next(err)
    }
  })

  /**
   * Runs an action and streams the answer.
   *
   * Server-sent events over a POST, so the request can carry what it is about
   * — EventSource only issues GETs, which would put a line range and a note in
   * a query string and make every answer cacheable by anything in between.
   *
   * The failure case is the interesting one. Headers go out before the model
   * is called, so by the time anything can go wrong the status is already 200
   * and there is no way to send a 502. An error therefore travels as an
   * `error` frame, and the client treats a stream that ends without `result`
   * as a failure whether or not it saw one — a connection dropped mid-answer
   * produces neither.
   */
  router.post(
    '/runs',
    requireAuth,
    copilotLimiter,
    validate(runSchema),
    async (req, res, next) => {
      let room
      try {
        room = await readableRoom(req)
        if (!can(room, req.user.id, CAPABILITIES.COPILOT_USE)) {
          throw refusalFor(room, req.user.id, CAPABILITIES.COPILOT_USE)
        }
      } catch (err) {
        // Still an ordinary request: nothing has been written yet, so a
        // refusal can be a refusal rather than a frame inside a 200.
        next(err)
        return
      }

      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Nginx buffers proxied responses by default, which turns a stream
        // into one delivery at the end and makes this feature pointless.
        'X-Accel-Buffering': 'no',
      })
      res.flushHeaders?.()

      const send = (event, data) => {
        if (res.writableEnded) return
        res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')
      }

      /**
       * The browser closed the tab, or the person pressed stop.
       *
       * Passed down to the model call so the provider stops being paid for an
       * answer nobody is going to read. The run is still recorded — it
       * happened, and it cost something.
       */
      const abort = new AbortController()
      req.on('close', () => abort.abort())

      const { action, ...input } = req.body

      try {
        await runCopilotAction({
          room,
          user: req.user,
          actionId: action,
          input,
          onEvent: send,
          signal: abort.signal,
        })
      } catch (err) {
        logger.warn(
          { room: room.roomId, action, code: err?.code },
          'a copilot run did not finish'
        )
        send('error', {
          code: err?.code ?? 'copilot_failed',
          message: err?.message ?? 'The copilot could not answer.',
          run: err?.run ?? null,
        })
      } finally {
        send('done', {})
        res.end()
      }
    }
  )

  /** The room's copilot history, newest first. Follows access to the room. */
  router.get('/runs', optionalAuth, async (req, res, next) => {
    try {
      await readableRoom(req)
      res.json({ runs: await listCopilotRuns(req.params.roomId, { limit: req.query.limit }) })
    } catch (err) {
      next(err)
    }
  })

  router.get('/runs/:runId', optionalAuth, async (req, res, next) => {
    try {
      await readableRoom(req)
      const run = await getCopilotRun(req.params.roomId, req.params.runId)
      res.json({ run: run.toPublic() })
    } catch (err) {
      next(err)
    }
  })

  /**
   * Accepts part of a proposed change set.
   *
   * `accept` names what is being taken; everything else is recorded as
   * rejected, so an empty array is a real answer rather than a no-op.
   */
  router.post(
    '/runs/:runId/apply',
    requireAuth,
    validate(applySchema),
    async (req, res, next) => {
      try {
        const room = await readableRoom(req)
        res.json(
          await applyCopilotFiles({
            room,
            runId: req.params.runId,
            user: req.user,
            accept: req.body.accept,
          })
        )
      } catch (err) {
        next(err)
      }
    }
  )

  /** Records what became of a proposed change to the shared buffer. */
  router.post(
    '/runs/:runId/patch',
    requireAuth,
    validate(patchSchema),
    async (req, res, next) => {
      try {
        const room = await readableRoom(req)
        res.json(
          await recordPatchOutcome({
            room,
            runId: req.params.runId,
            user: req.user,
            outcome: req.body.outcome,
          })
        )
      } catch (err) {
        next(err)
      }
    }
  )

  return router
}
