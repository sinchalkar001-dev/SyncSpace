import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { unavailable } from '../../errors.js'
import * as dockerBackend from './backends/docker.backend.js'
import * as processBackend from './backends/process.backend.js'

/**
 * Which of the two ways of running a program this deployment uses.
 *
 * The setting has three values and the difference between two of them is the
 * whole point:
 *
 *   docker    containers, and if there is no container runtime then nothing
 *             runs at all
 *   process   a child process on this machine, which is not a sandbox
 *   auto      containers when they are available, a child process otherwise
 *
 * `auto` is the default because it is what makes the feature work on a laptop.
 * `docker` exists so that a production deployment can say "isolated or not at
 * all" and mean it. A silent downgrade from container to bare process is
 * precisely the failure worth refusing: everything keeps working, the tests
 * keep passing, and the isolation is gone.
 */

const BACKENDS = { docker: dockerBackend, process: processBackend }

let resolved = null

async function choose() {
  const requested = env.SANDBOX_BACKEND

  if (requested === 'process') {
    logger.warn(
      'code execution is using the process backend: programs run unsandboxed on this machine'
    )
    return processBackend
  }

  const dockerReady = await dockerBackend.available()

  if (requested === 'docker') {
    if (!dockerReady) {
      // Deliberately not falling back. Someone asked for isolation.
      logger.error('SANDBOX_BACKEND=docker but no container runtime answered; execution is disabled')
      return null
    }
    return dockerBackend
  }

  if (dockerReady) return dockerBackend

  logger.warn(
    'no container runtime found; falling back to the process backend, which is not a sandbox. ' +
      'Set SANDBOX_BACKEND=docker to refuse unsandboxed execution instead.'
  )
  return processBackend
}

/**
 * The backend, resolved once.
 *
 * Probing the daemon costs a process, and whether Docker is installed is not
 * something that changes while a server is up — the same reasoning as the
 * toolchain probe it sits beside.
 */
export async function activeBackend() {
  if (!resolved) resolved = choose()
  return resolved
}

/** The backend, or a refusal explaining why there is not one. */
export async function requireBackend() {
  const backend = await activeBackend()

  if (!backend) {
    throw unavailable(
      'Isolated execution is not available on this server, so running code is switched off',
      'sandbox_unavailable'
    )
  }

  return backend
}

/** The name alone, for anything reporting configuration rather than running. */
export async function activeBackendName() {
  return (await activeBackend())?.name ?? null
}

/** Test seam, and the hook the pull script uses after changing the setting. */
export function resetBackendCache() {
  resolved = null
  dockerBackend.resetAvailabilityCache()
}

export { BACKENDS }
