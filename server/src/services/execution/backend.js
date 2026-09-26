import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { unavailable } from '../../errors.js'
import * as dockerBackend from './backends/docker.backend.js'
import * as processBackend from './backends/process.backend.js'
import * as vercelBackend from './backends/vercel.backend.js'

/**
 * Which of the ways of running a program this deployment uses.
 *
 * The setting has four values and the difference between some of them is the
 * whole point:
 *
 *   docker    containers, and if there is no container runtime then nothing
 *             runs at all
 *   vercel    a microVM per run on Vercel Sandbox, and if there are no
 *             credentials for it then nothing runs at all
 *   process   a child process on this machine, which is not a sandbox
 *   auto      containers when they are available, a child process otherwise
 *
 * `auto` is the default because it is what makes the feature work on a laptop.
 * `docker` and `vercel` exist so that a production deployment can say
 * "isolated or not at all" and mean it. A silent downgrade from a sandbox to a
 * bare process is precisely the failure worth refusing: everything keeps
 * working, the tests keep passing, and the isolation is gone.
 *
 * `auto` never picks `vercel`. Sending code to somebody's cloud account is a
 * decision, and it costs their allowance — it is not something to discover
 * because three environment variables happened to be set.
 */

const BACKENDS = { docker: dockerBackend, process: processBackend, vercel: vercelBackend }

let resolved = null

/**
 * A backend that was asked for by name and cannot be had.
 *
 * Deliberately not falling back. Someone asked for isolation.
 */
function refuse(requested, reason) {
  refusal = reason
  logger.error({ reason }, 'SANDBOX_BACKEND=' + requested + ' cannot be honoured; execution is disabled')
  return null
}

async function choose() {
  const requested = env.SANDBOX_BACKEND

  if (requested === 'process') {
    logger.warn(
      'code execution is using the process backend: programs run unsandboxed on this machine'
    )
    return processBackend
  }

  if (requested === 'vercel') {
    const vercel = await vercelBackend.readiness()
    return vercel.ok ? vercelBackend : refuse(requested, vercel.reason)
  }

  // Readiness, not merely presence. A daemon with no images answers every
  // question correctly and still cannot run a program inside the time budget —
  // it turns each run into a silent image download that ends as a timeout.
  const docker = await dockerBackend.readiness()

  if (requested === 'docker') {
    return docker.ok ? dockerBackend : refuse(requested, docker.reason)
  }

  if (docker.ok) return dockerBackend

  logger.warn(
    { reason: docker.reason },
    'falling back to the process backend, which is not a sandbox. ' +
      'Set SANDBOX_BACKEND=docker to refuse unsandboxed execution instead.'
  )
  return processBackend
}

/** Kept so the refusal can say which of the reasons it was. */
let refusal = null

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
      'Isolated execution is not available on this server, so running code is switched off' +
        (refusal ? ' — ' + refusal : ''),
      'sandbox_unavailable'
    )
  }

  return backend
}

/** The name alone, for anything reporting configuration rather than running. */
export async function activeBackendName() {
  return (await activeBackend())?.name ?? null
}

/**
 * Why there is no backend, once the choice has been made and there is not.
 *
 * For /runners, so a Run button can say "VERCEL_TOKEN is not set" rather than
 * blaming a missing compiler that was never the problem.
 */
export async function refusalReason() {
  return (await activeBackend()) ? null : refusal
}

/**
 * Gets a slow backend going before anybody needs it.
 *
 * Only the Vercel one is slow to get going: on a first start it builds the
 * snapshot every run boots from, which takes minutes. Started here, at boot,
 * that is minutes nobody spends looking at a disabled Run button. Its
 * leftovers from an earlier process are cleared at the same time.
 */
export async function warmUpBackend() {
  if (!env.ALLOW_CODE_EXECUTION || env.SANDBOX_BACKEND !== 'vercel') return

  const backend = await activeBackend()
  if (backend !== vercelBackend) return

  vercelBackend.reap().catch((error) => {
    logger.warn({ err: error }, 'could not look for leftover run sandboxes')
  })
}

/** Test seam, and the hook the pull script uses after changing the setting. */
export function resetBackendCache() {
  resolved = null
  refusal = null
  dockerBackend.resetAvailabilityCache()
  vercelBackend.resetAvailabilityCache()
}

export { BACKENDS }
