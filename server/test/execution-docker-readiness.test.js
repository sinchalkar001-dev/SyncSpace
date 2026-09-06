import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * "Is there a container runtime" and "can this machine run a container" are
 * different questions, and answering the first one twice is what turned CI
 * red while everything passed locally.
 *
 * A GitHub runner ships with Docker installed and no images. `docker version`
 * answers instantly and correctly; `docker run node:22-alpine` then becomes a
 * silent image download measured against a five-second execution budget, so
 * every language fails at once as a timeout, and the word "image" appears
 * nowhere in any of it.
 *
 * The daemon is faked here rather than required, so this runs the same on a
 * laptop with Docker, a laptop without it, and the runner that started it.
 */

vi.mock('../src/services/execution/spawn.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawnCollect: vi.fn(),
}))

const { spawnCollect } = await import('../src/services/execution/spawn.js')
const docker = await import('../src/services/execution/backends/docker.backend.js')
const { env } = await import('../src/config/env.js')

const answered = (over = {}) => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  failedToStart: false,
  truncated: false,
  timedOut: false,
  cancelled: false,
  durationMs: 1,
  ...over,
})

/** A daemon that answers, and a machine holding the images it is told to. */
function fakeDocker({ daemon = true, images = [] }) {
  spawnCollect.mockImplementation((_bin, args) => {
    if (args[0] === 'version') {
      return Promise.resolve(
        daemon ? answered({ stdout: '27.0.0\n' }) : answered({ exitCode: 1, failedToStart: true })
      )
    }

    if (args[0] === 'image' && args[1] === 'inspect') {
      const wanted = args[2]
      return Promise.resolve(images.includes(wanted) ? answered() : answered({ exitCode: 1 }))
    }

    return Promise.resolve(answered({ exitCode: 1 }))
  })
}

const originalPull = env.SANDBOX_PULL

beforeEach(() => {
  docker.resetAvailabilityCache()
  env.SANDBOX_PULL = false
})

afterEach(() => {
  env.SANDBOX_PULL = originalPull
  vi.clearAllMocks()
})

describe('whether containers can actually run something here', () => {
  it('is ready when the daemon answers and an image is present', async () => {
    fakeDocker({ daemon: true, images: ['node:22-alpine'] })

    expect(await docker.readiness()).toEqual({ ok: true, reason: null })
  })

  /** The CI shape, and the one this whole file exists for. */
  it('is not ready when the daemon answers but nothing has been pulled', async () => {
    fakeDocker({ daemon: true, images: [] })

    const result = await docker.readiness()

    expect(result.ok).toBe(false)
    // The fix is a pull, and the message has to say so — "unavailable" alone
    // sends somebody to look at the daemon, which is working perfectly.
    expect(result.reason).toContain('images')
    expect(result.reason).toContain('sandbox:pull')
  })

  it('distinguishes that from having no runtime at all', async () => {
    fakeDocker({ daemon: false })

    const result = await docker.readiness()

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no container runtime')
    expect(result.reason).not.toContain('images')
  })

  /**
   * With pulling turned on a missing image is a slow first run rather than a
   * broken one, so it is not a reason to refuse.
   */
  it('is ready with no images when this deployment will fetch them', async () => {
    env.SANDBOX_PULL = true
    fakeDocker({ daemon: true, images: [] })

    expect((await docker.readiness()).ok).toBe(true)
  })

  it('asks the daemon once, however many languages there are', async () => {
    fakeDocker({ daemon: true, images: ['node:22-alpine'] })

    await docker.readiness()
    await docker.readiness()

    const versionCalls = spawnCollect.mock.calls.filter(([, args]) => args[0] === 'version')
    expect(versionCalls).toHaveLength(1)
  })
})
