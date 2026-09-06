import { logger } from '../config/logger.js'
import { activeBackend } from './execution/backend.js'
import { RECIPES, RUNNABLE_LANGUAGES } from './execution/recipes.js'
import { runCode, startExecution } from './execution.service.js'

/**
 * What this server can run, and the name the rest of the app calls to run it.
 *
 * The execution itself moved out — into `execution/`, behind a queue and a
 * sandbox — but this module keeps its name and its exports. Routes, tests and
 * the OpenAPI document all reach for `runCode` and `listRunnable`, and there
 * was no reason to make an isolation change into a rename everywhere as well.
 */

export { RECIPES, RUNNABLE_LANGUAGES, runCode, startExecution }

let availability = null

/**
 * Which languages this machine can actually run.
 *
 * The question is now backend-shaped rather than machine-shaped: with the
 * process backend it means "is the toolchain installed", and with Docker it
 * means "is the image here". Both are asked once and remembered — installing a
 * compiler or pulling an image while the server is up is not a case worth
 * re-checking on every request for.
 */
export function listRunnable() {
  if (availability) return availability

  availability = (async () => {
    const backend = await activeBackend()

    // No backend at all is a deployment that asked for containers and has
    // none. Every language is unavailable, and `/runners` says why.
    if (!backend) {
      return RUNNABLE_LANGUAGES.map((language) => ({
        language,
        available: false,
        toolchain: RECIPES[language].toolchain,
        version: '',
      }))
    }

    return Promise.all(
      RUNNABLE_LANGUAGES.map(async (language) => {
        const probed = await backend.probe(RECIPES[language], { language })

        return {
          language,
          available: probed.available,
          toolchain: RECIPES[language].toolchain,
          version: (probed.version || '').slice(0, 80),
        }
      })
    )
  })().catch((error) => {
    logger.warn({ err: error }, 'could not probe what this server can run')
    availability = null
    return []
  })

  return availability
}

/** Test seam: forces the next listRunnable() to probe again. */
export function resetRunnableCache() {
  availability = null
}
