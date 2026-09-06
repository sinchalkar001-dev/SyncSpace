import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../src/config/env.js'
import {
  activeBackend,
  activeBackendName,
  requireBackend,
  resetBackendCache,
} from '../src/services/execution/backend.js'
import * as dockerBackend from '../src/services/execution/backends/docker.backend.js'

/**
 * Choosing between a container and a bare process.
 *
 * The setting has three values and the difference between two of them is the
 * entire point of this feature. `auto` on a host whose Docker daemon is down
 * silently becomes an unsandboxed runner: every test still passes, the
 * programs still print their answers, and untrusted code is running with the
 * server's own filesystem and network access. `docker` has to refuse instead —
 * that is what makes "isolated or not at all" a thing a deployment can say.
 *
 * These are the tests that would fail if somebody added a well-meaning
 * fallback to the `docker` branch.
 */

const original = env.SANDBOX_BACKEND

afterEach(() => {
  env.SANDBOX_BACKEND = original
  vi.restoreAllMocks()
  resetBackendCache()
})

/**
 * Pretends containers are usable, or are not, without needing either.
 *
 * `readiness` rather than `available` because those are different questions
 * and the difference is what broke CI: a runner with Docker installed and no
 * images answers "available" perfectly well, then turns every run into an
 * image download that ends as a timeout.
 */
const withDocker = (ready, reason = 'no container runtime answered') => {
  vi.spyOn(dockerBackend, 'readiness').mockResolvedValue({ ok: ready, reason: ready ? null : reason })
  resetBackendCache()
}

describe('choosing a backend', () => {
  it('uses containers when they are there', async () => {
    env.SANDBOX_BACKEND = 'auto'
    withDocker(true)

    expect(await activeBackendName()).toBe('docker')
  })

  it('falls back to a process when they are not, so a laptop still works', async () => {
    env.SANDBOX_BACKEND = 'auto'
    withDocker(false)

    expect(await activeBackendName()).toBe('process')
  })

  it('uses a process when asked to, without consulting anything', async () => {
    env.SANDBOX_BACKEND = 'process'
    withDocker(true)

    expect(await activeBackendName()).toBe('process')
  })

  /**
   * The one that matters. A deployment that asked for isolation and cannot
   * have it must not quietly get the other thing.
   */
  it('refuses outright when containers were required and are missing', async () => {
    env.SANDBOX_BACKEND = 'docker'
    withDocker(false)

    expect(await activeBackend()).toBeNull()
    await expect(requireBackend()).rejects.toMatchObject({
      status: 503,
      code: 'sandbox_unavailable',
    })
  })

  it('uses containers when they were required and are present', async () => {
    env.SANDBOX_BACKEND = 'docker'
    withDocker(true)

    expect((await requireBackend()).name).toBe('docker')
  })

  /** Probing the daemon costs a process, and the answer does not change. */
  it('asks once and remembers', async () => {
    env.SANDBOX_BACKEND = 'auto'
    const probe = vi.spyOn(dockerBackend, 'readiness').mockResolvedValue({ ok: true, reason: null })
    resetBackendCache()

    await activeBackend()
    await activeBackend()
    await activeBackend()

    expect(probe).toHaveBeenCalledTimes(1)
  })
})

/**
 * The case that only appears on a machine somebody else set up.
 *
 * A container runtime with none of its images is not a broken installation —
 * it is the default state of every CI runner and of any laptop where Docker
 * arrived with the operating system. Treating it as "containers are available"
 * makes every run a silent image download against a five-second budget, which
 * arrives as a timeout on every language at once and says nothing about
 * images anywhere.
 */
describe('a runtime with no images', () => {
  it('is not treated as usable, and falls back with a reason', async () => {
    env.SANDBOX_BACKEND = 'auto'
    withDocker(false, 'a container runtime is present but none of its execution images are')

    expect(await activeBackendName()).toBe('process')
  })

  it('refuses, and says which of the two problems it is', async () => {
    env.SANDBOX_BACKEND = 'docker'
    withDocker(false, 'a container runtime is present but none of its execution images are')

    await expect(requireBackend()).rejects.toMatchObject({
      status: 503,
      code: 'sandbox_unavailable',
      // Not merely "unavailable": the fix is a pull, and the message says so.
      message: expect.stringContaining('none of its execution images'),
    })
  })
})
