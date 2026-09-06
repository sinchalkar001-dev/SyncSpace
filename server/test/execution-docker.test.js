import { afterEach, describe, expect, it } from 'vitest'
import { env } from '../src/config/env.js'
import { buildRunArgs, resolveUser } from '../src/services/execution/backends/docker.backend.js'
import { resolveLimits } from '../src/services/execution/limits.js'

/**
 * The sandbox, read as an argument list.
 *
 * Every security property of the Docker backend is a flag in this array, and
 * none of them is observable from a passing end-to-end test: a container
 * missing `--network none` runs the program, prints the answer, and has had a
 * route to the cloud metadata endpoint the entire time. Nothing goes wrong
 * until something does.
 *
 * So the flags are asserted directly, one at a time, with a note on each about
 * what it stops. A test that only checked "docker was invoked" would be
 * satisfied by `docker run --privileged`.
 */

const BASE = {
  executionId: '11111111-2222-3333-4444-555555555555',
  image: 'node:22-alpine',
  workDir: '/tmp/syncspace-run-abc',
  command: 'node',
  args: ['main.js'],
  containerName: 'syncspace-111111112222-run',
}

const original = {
  network: env.SANDBOX_NETWORK,
  networkName: env.SANDBOX_NETWORK_NAME,
  user: env.SANDBOX_USER,
  runtime: env.SANDBOX_RUNTIME,
  memory: env.SANDBOX_MEMORY_MB,
  pids: env.SANDBOX_PIDS,
}

afterEach(() => {
  env.SANDBOX_NETWORK = original.network
  env.SANDBOX_NETWORK_NAME = original.networkName
  env.SANDBOX_USER = original.user
  env.SANDBOX_RUNTIME = original.runtime
  env.SANDBOX_MEMORY_MB = original.memory
  env.SANDBOX_PIDS = original.pids
})

const build = (overrides = {}) =>
  buildRunArgs({ ...BASE, limits: { ...resolveLimits(), ...overrides.limits }, ...overrides })

/** The value that follows a flag, which is how docker takes its arguments. */
const valueOf = (args, flag) => args[args.indexOf(flag) + 1]

describe('the flags that make it a sandbox', () => {
  it('gives the container no network at all', () => {
    expect(valueOf(build(), '--network')).toBe('none')
  })

  /**
   * Not a default anybody reaches by accident: a program with a network can
   * read the cloud metadata endpoint that hands out credentials, scan the
   * private network the server sits in, and post what it finds elsewhere.
   */
  it('only joins a network when a deployment has deliberately said so', () => {
    env.SANDBOX_NETWORK = true
    env.SANDBOX_NETWORK_NAME = 'sandbox-net'

    expect(valueOf(build(), '--network')).toBe('sandbox-net')
  })

  it('caps memory, and does not let swap be the way around it', () => {
    env.SANDBOX_MEMORY_MB = 128
    const args = build()

    expect(valueOf(args, '--memory')).toBe('128m')
    // Equal to --memory. Without this the container swaps instead of being
    // killed, and a memory limit becomes a machine-wide slowdown.
    expect(valueOf(args, '--memory-swap')).toBe('128m')
  })

  it('caps processes, which is the whole answer to a fork bomb', () => {
    env.SANDBOX_PIDS = 32
    expect(valueOf(build(), '--pids-limit')).toBe('32')
  })

  it('caps CPU', () => {
    expect(Number(valueOf(build(), '--cpus'))).toBeGreaterThan(0)
  })

  it('makes everything read-only except the directory the run owns', () => {
    const args = build()

    expect(args).toContain('--read-only')
    expect(valueOf(args, '--volume')).toBe(BASE.workDir + ':/work:rw')
    expect(valueOf(args, '--workdir')).toBe('/work')
  })

  it('gives /tmp a size, so filling it is bounded', () => {
    const tmpfs = valueOf(build(), '--tmpfs')

    expect(tmpfs).toMatch(/^\/tmp:/)
    expect(tmpfs).toMatch(/size=\d+m/)
    expect(tmpfs).toContain('nosuid')
  })

  it('drops every capability and forbids getting one back', () => {
    const args = build()

    expect(valueOf(args, '--cap-drop')).toBe('ALL')
    // Without this, a setuid binary inside the image is a way to climb back
    // out of the unprivileged user below.
    expect(valueOf(args, '--security-opt')).toBe('no-new-privileges')
  })

  it('never runs the program as root', () => {
    const user = valueOf(build(), '--user')

    expect(user).toMatch(/^\d+:\d+$/)
    expect(user.startsWith('0:')).toBe(false)
  })

  it('caps the size of any file written, so the host disk cannot be filled', () => {
    const ulimits = build().filter((_, index, args) => args[index - 1] === '--ulimit')
    expect(ulimits.some((value) => value.startsWith('fsize='))).toBe(true)
  })

  it('passes a runtime through when one is configured, for gVisor or Kata', () => {
    expect(build()).not.toContain('--runtime')

    env.SANDBOX_RUNTIME = 'runsc'
    expect(valueOf(build(), '--runtime')).toBe('runsc')
  })
})

describe('what the container is told', () => {
  /**
   * Docker passes none of the server's environment by default, which is the
   * one thing this backend gets for free that the process backend has to work
   * for. This is the test that would notice if somebody added `--env-file` or
   * a bare `-e` pass-through for convenience.
   */
  it('carries no server secret into the container', () => {
    process.env.MONGODB_URI = 'mongodb://someone:hunter2@localhost:27017/syncspace'
    process.env.JWT_SECRET = 'a-very-secret-signing-key'

    const flat = build().join(' ')

    expect(flat).not.toContain('hunter2')
    expect(flat).not.toContain('a-very-secret-signing-key')
    expect(flat).not.toContain('MONGODB_URI')
    expect(flat).not.toContain('JWT_SECRET')
  })

  it('sets only the variables a toolchain needs to work read-only', () => {
    const values = build().filter((_, index, args) => args[index - 1] === '--env')

    expect(values).toContain('HOME=/tmp')
    // Go and Cargo write caches, and everything but /tmp and /work is
    // read-only, so they have to be pointed somewhere writable or the build
    // fails with an error about a directory rather than about the program.
    expect(values.some((value) => value.startsWith('GOCACHE='))).toBe(true)
    expect(values.some((value) => value.startsWith('CARGO_HOME='))).toBe(true)
  })

  it('puts the image and the program last, in that order', () => {
    const args = build()
    const image = args.indexOf('node:22-alpine')

    expect(image).toBeGreaterThan(0)
    expect(args.slice(image)).toEqual(['node:22-alpine', 'node', 'main.js'])
  })

  /** Both are how a container is found again if this server dies mid-run. */
  it('names and labels the container so an orphan can be reclaimed', () => {
    const args = build()

    expect(valueOf(args, '--name')).toBe(BASE.containerName)
    expect(valueOf(args, '--label')).toBe('syncspace.execution=' + BASE.executionId)
  })

  it('keeps stdin open, because a program may be given input', () => {
    expect(build()).toContain('--interactive')
  })
})

describe('who the program runs as', () => {
  it('honours an explicit setting', () => {
    env.SANDBOX_USER = '1000:1000'
    expect(resolveUser()).toBe('1000:1000')
  })

  it('falls back to a real unprivileged pair', () => {
    env.SANDBOX_USER = undefined
    expect(resolveUser()).toMatch(/^\d+:\d+$/)
    expect(resolveUser()).not.toBe('0:0')
  })
})
