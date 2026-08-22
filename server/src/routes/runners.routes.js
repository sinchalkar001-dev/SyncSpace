import { Router } from 'express'
import { env } from '../config/env.js'
import { listRunnable } from '../services/runner.service.js'

/**
 * What this server can run.
 *
 * Deliberately not under a room: which toolchains are installed is a property
 * of the machine, and asking per room would tie a UI decision — whether the
 * Run button is even offered — to a room record that may not exist yet for a
 * document someone just opened by typing a URL.
 */
export function createRunnersRouter() {
  const router = Router()

  router.get('/', async (_req, res, next) => {
    try {
      res.json({
        enabled: env.ALLOW_CODE_EXECUTION,
        timeoutMs: env.RUN_TIMEOUT_MS,
        languages: env.ALLOW_CODE_EXECUTION ? await listRunnable() : [],
      })
    } catch (err) {
      next(err)
    }
  })

  return router
}
