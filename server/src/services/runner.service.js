import { logger } from '../config/logger.js'
import { activeBackend, refusalReason } from './execution/backend.js'
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
 * process backend it means "is the toolchain installed", with Docker it means
 * "is the image here", and with Vercel it means "is the snapshot built". The
 * first two are asked once and remembered — installing a compiler or pulling
 * an image while the server is up is not a case worth re-checking on every
 * request for.
 *
 * The third is the exception, and says so with `answersChange`: its snapshot
 * is built while the server is up, and can be lost and rebuilt, so
 * remembering "not yet" would make it "never" for the life of the process. A
 * language on its way is marked `pending`, which is what tells the interface
 * to ask again later.
 */
export function listRunnable() {
  if (availability) return availability

  const listing = (availability = (async () => {
    const backend = await activeBackend()

    // No backend at all is a deployment that asked for a sandbox it cannot
    // have. Every language is unavailable, and `/runners` says why — per
    // language too, since that is where the Run button looks.
    if (!backend) {
      const why = await refusalReason()

      return RUNNABLE_LANGUAGES.map((language) => ({
        language,
        available: false,
        toolchain: RECIPES[language].toolchain,
        version: '',
        ...(why ? { reason: ('Running code is switched off on this server: ' + why).slice(0, 300) } : {}),
      }))
    }

    const languages = await Promise.all(
      RUNNABLE_LANGUAGES.map(async (language) => {
        const probed = await backend.probe(RECIPES[language], { language })

        return {
          language,
          available: probed.available,
          toolchain: RECIPES[language].toolchain,
          version: (probed.version || '').slice(0, 80),
          // Only when the backend has something better to say than "not
          // installed" — a toolchain being built, or why it could not be.
          ...(probed.reason ? { reason: String(probed.reason).slice(0, 300) } : {}),
          ...(probed.pending ? { pending: true } : {}),
        }
      })
    )

    // Not remembered where the answer can change while the server is up; see
    // above. Such a backend answers from memory, so asking again is free.
    if (backend.answersChange && availability === listing) availability = null

    return languages
  })().catch((error) => {
    logger.warn({ err: error }, 'could not probe what this server can run')
    availability = null
    return []
  }))

  return listing
}

/** Test seam: forces the next listRunnable() to probe again. */
export function resetRunnableCache() {
  availability = null
}
