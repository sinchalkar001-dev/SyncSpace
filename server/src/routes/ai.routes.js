import { Router } from 'express'
import { aiStatus } from '../services/ai.service.js'

/**
 * Whether this server can reach a model at all, and why not when it cannot.
 *
 * A sibling of `/runners` and for the same reason: whether a model is reachable
 * is a property of the deployment, not of a room, and an interface needs the
 * answer before it decides whether to offer a button. A feature that is
 * switched off should say so where somebody would look for it, rather than
 * failing when they press it.
 *
 * Public, like `/runners`. It reports that a key exists, never what it is, and
 * a guest deciding whether to bother signing in is entitled to know the
 * feature is there.
 *
 * The copilot has a catalogue of its own, because what it can do depends on
 * the room and on who is asking. This one is the deployment-wide answer, and
 * is what the session summaries ask before offering to write one.
 */
export function createAiRouter() {
  const router = Router()

  router.get('/', (_req, res) => {
    res.json(aiStatus())
  })

  return router
}
