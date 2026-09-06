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

/** Pretends the daemon is there, or is not, without needing either. */
const withDocker = (present) => {
  vi.spyOn(dockerBackend, 'available').mockResolvedValue(present)
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
    const probe = vi.spyOn(dockerBackend, 'available').mockResolvedValue(true)
    resetBackendCache()

    await activeBackend()
    await activeBackend()
    await activeBackend()

    expect(probe).toHaveBeenCalledTimes(1)
  })
})
