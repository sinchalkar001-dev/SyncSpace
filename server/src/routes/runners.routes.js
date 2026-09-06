import { Router } from 'express'
import { env } from '../config/env.js'
import { listRunnable } from '../services/runner.service.js'
import { isolationStatus } from '../services/execution.service.js'

/**
 * What this server can run, and what it will and will not stop that program
 * from doing.
 *
 * Deliberately not under a room: which toolchains are installed is a property
 * of the machine, and asking per room would tie a UI decision — whether the
 * Run button is even offered — to a room record that may not exist yet for a
 * document someone just opened by typing a URL.
 *
 * The isolation half is reported for the same reason the language list is. A
 * person about to run somebody else's code in a public room should be able to
 * find out whether it is contained, and "read the deployment's environment
 * variables" is not an answer available to them.
 */
export function createRunnersRouter() {
  const router = Router()

  router.get('/', async (_req, res, next) => {
    try {
      const isolation = env.ALLOW_CODE_EXECUTION ? await isolationStatus() : null

      res.json({
        enabled: env.ALLOW_CODE_EXECUTION,
        timeoutMs: env.RUN_TIMEOUT_MS,
        languages: env.ALLOW_CODE_EXECUTION ? await listRunnable() : [],
        isolation,
      })
    } catch (err) {
      next(err)
    }
  })

  return router
}
