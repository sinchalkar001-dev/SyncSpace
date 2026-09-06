import { Router } from 'express'
import { aiStatus, TARGETS } from '../services/ai.service.js'

/**
 * Whether this server can generate code, and what it can be asked for.
 *
 * A sibling of `/runners` and for the same reason: whether a model is reachable
 * is a property of the deployment, not of a room, and the UI needs the answer
 * before it decides whether to offer the button at all. A feature that is
 * switched off should say so where somebody would look for it, rather than
 * failing when they press it.
 *
 * Public, like `/runners`. It reports that a key exists, never what it is, and
 * a guest deciding whether to bother signing in is entitled to know the
 * feature is there.
 */
export function createAiRouter() {
  const router = Router()

  router.get('/', (_req, res) => {
    const status = aiStatus()
    res.json({
      ...status,
      targets: Object.entries(TARGETS).map(([key, description]) => ({ key, description })),
    })
  })

  return router
}
