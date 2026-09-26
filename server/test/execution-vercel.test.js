import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real SDK, talking to an in-memory Vercel instead of the network: every
// request this backend makes goes through the SDK's own argument handling,
// and a call it would reject in production is rejected here.
vi.mock('@vercel/sandbox', () => import('@vercel/sandbox-mock'))

import { command, Sandbox, setupSandbox, Snapshot } from '@vercel/sandbox-mock'
import { env } from '../src/config/env.js'
import {
  activeBackend,
  activeBackendName,
  requireBackend,
  resetBackendCache,
} from '../src/services/execution/backend.js'
import * as dockerBackend from '../src/services/execution/backends/docker.backend.js'
import * as vercel from '../src/services/execution/backends/vercel.backend.js'
import {
  BASE_IMAGE,
  builderName,
  decodeVersions,
  encodeVersions,
  parseVersions,
  prepareToolchain,
  resetToolchain,
  toolchainState,
} from '../src/services/execution/backends/vercel/toolchain.js'
import { describeIsolation, resolveLimits, TERMINATION, vcpusFor } from '../src/services/execution/limits.js'
import { RECIPES } from '../src/services/execution/recipes.js'
import { resetQueue } from '../src/services/execution.service.js'
import { listRunnable, resetRunnableCache, runCode } from '../src/services/runner.service.js'

/**
 * Running code on Vercel Sandbox, without Vercel.
 *
 * What a real microVM does with run.sh — nobody, the rlimits, the timeout, the
 * missing network — was checked against the real toolchains on Ubuntu 26.04
 * when the script was written, and is not something an in-memory mock can
 * say anything about. What this file checks is everything on this side of
 * the API: which machine is asked for and how, what happens to it afterwards,
 * how the snapshot comes to exist and is found again, and how each way a run
 * can end becomes the result the room sees.
 */

const SETUP_OUTPUT = [
  'Setting up default-jdk-headless (2:1.25-77) ...',
  'syncspace-version javascript v24.9.0',
  'syncspace-version typescript v24.9.0',
  'syncspace-version python Python 3.14.4',
  'syncspace-version java openjdk version "25.0.4.1" 2026-08-18',
  'syncspace-version cpp g++ (Ubuntu 15.2.0-16ubuntu1) 15.2.0',
  'syncspace-version go go1.26.0',
  'syncspace-version rust rustc 1.93.1 (01f6ddf75 2026-02-11)',
  '',
].join('\n')

const setupCalls = { count: 0 }

const server = setupSandbox(
  command(/^bash \/tmp\/syncspace-setup\.sh/, () => {
    setupCalls.count += 1
    return { stdout: SETUP_OUTPUT, exitCode: 0 }
  })
)

/** A program, as the run script would report it. Registered before the VM starts. */
const onStep = (respond) =>
  server.use(command(/^bash \/tmp\/syncspace\/run\.sh step/, respond))

const onOomCheck = (exitCode) =>
  server.use(command(/^bash \/tmp\/syncspace\/run\.sh oom/, { exitCode }))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const saved = {}
const KEYS = [
  'SANDBOX_BACKEND',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID',
  'SANDBOX_REGION',
  'RUN_TIMEOUT_MS',
  'RUN_OUTPUT_LIMIT',
  'SANDBOX_CPUS',
  'SANDBOX_NETWORK',
]

beforeEach(() => {
  for (const key of KEYS) saved[key] = env[key]
  env.SANDBOX_BACKEND = 'vercel'
  env.VERCEL_TOKEN = 'test-token'
  env.VERCEL_TEAM_ID = 'team_test'
  env.VERCEL_PROJECT_ID = 'prj_test'
  env.SANDBOX_REGION = 'sin1'
  setupCalls.count = 0
  resetBackendCache()
  resetRunnableCache()
})

afterEach(async () => {
  // Before the handlers and the store go, or a builder still on its way would
  // re-create its sandbox in the middle of the next test.
  await settleToolchain()

  for (const key of KEYS) env[key] = saved[key]
  server.resetHandlers()
  resetQueue()
  resetBackendCache()
  resetRunnableCache()
  vi.restoreAllMocks()
})

/**
 * Waits for a build an earlier test left running.
 *
 * `readiness()` starts the toolchain build and deliberately does not wait for
 * it: the first person to open a room should not be the one who waits for
 * apt. That is right in a server and a trap in a suite, because resetting the
 * toolchain makes `prepareToolchain()` forget the builder without stopping it
 * — so the next test starts a second one, and both install. Joining it here
 * is what keeps each test's world its own.
 */
async function settleToolchain() {
  // Bounded, and it never starts anything: while a build is in flight
  // `prepareToolchain()` hands back that same promise.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { status } = toolchainState()
    if (status !== 'checking' && status !== 'building') return
    await prepareToolchain().catch(() => {})
  }
}

/** The toolchains, built once through the real code path. */
async function ready() {
  await prepareToolchain()
  expect(toolchainState().status).toBe('ready')
  return toolchainState().snapshotId
}

const run = (language, code, { stdin = '', signal } = {}) =>
  vercel.execute({
    recipe: RECIPES[language],
    language,
    source: code,
    stdin,
    limits: resolveLimits('vercel'),
    signal,
    executionId: '00000000-0000-4000-8000-000000000000',
  })

/** Every run VM this server made that still exists. */
async function runSandboxes() {
  const page = await Sandbox.list({ tags: { role: 'run' } })
  return page.sandboxes
}

describe('choosing the vercel backend', () => {
  it('is used when it is asked for and has an account to use', async () => {
    expect(await activeBackendName()).toBe('vercel')
  })

  /**
   * The same promise the docker backend makes. A deployment that said
   * "vercel" and forgot the token must not end up running programs on the
   * server instead.
   */
  it('refuses outright without credentials, and names the missing ones', async () => {
    env.VERCEL_TOKEN = undefined
    env.VERCEL_PROJECT_ID = undefined
    resetBackendCache()

    expect(await activeBackend()).toBeNull()
    await expect(requireBackend()).rejects.toMatchObject({
      status: 503,
      code: 'sandbox_unavailable',
      message: expect.stringContaining('VERCEL_TOKEN, VERCEL_PROJECT_ID are not set'),
    })
  })

  /** Where the Run button looks, rather than only in the isolation report. */
  it('tells every language why, instead of blaming a missing compiler', async () => {
    env.VERCEL_TOKEN = undefined
    resetBackendCache()

    const entries = await listRunnable()

    expect(entries).toHaveLength(Object.keys(RECIPES).length)
    for (const entry of entries) {
      expect(entry.available).toBe(false)
      expect(entry.reason).toBe(
        'Running code is switched off on this server: VERCEL_TOKEN is not set, so there is no Vercel account to start sandboxes in'
      )
    }
  })

  /** Sending code to somebody's cloud account is a decision, not a fallback. */
  it('is never chosen by auto, whatever credentials are lying around', async () => {
    env.SANDBOX_BACKEND = 'auto'
    vi.spyOn(dockerBackend, 'readiness').mockResolvedValue({ ok: false, reason: 'no container runtime answered' })
    resetBackendCache()

    expect(await activeBackendName()).toBe('process')
  })
})

describe('the toolchain snapshot', () => {
  it('is built once, from Vercel\'s Node image, with network only for the build', async () => {
    const create = vi.spyOn(Sandbox, 'create')

    const snapshotId = await ready()

    expect(setupCalls.count).toBe(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toMatchObject({
      name: builderName(),
      image: BASE_IMAGE,
      region: 'sin1',
      networkPolicy: 'allow-all',
      persistent: false,
      token: 'test-token',
      teamId: 'team_test',
      projectId: 'prj_test',
    })

    const snapshot = await Snapshot.get({ snapshotId })
    expect(snapshot.status).toBe('created')
    // No expiry: a quiet month must not mean the next Run waits for apt.
    expect(snapshot.expiresAt).toBeUndefined()
  })

  it('reports what each toolchain answered with', async () => {
    await ready()

    expect(toolchainState().versions).toMatchObject({
      java: 'openjdk version "25.0.4.1" 2026-08-18',
      go: 'go1.26.0',
      rust: 'rustc 1.93.1 (01f6ddf75 2026-02-11)',
    })
  })

  /**
   * The free plan puts the server to sleep after a quarter of an hour. If
   * waking it meant another build, every first visitor of the day would wait
   * minutes for apt.
   */
  it('is found again by a later start instead of being built again', async () => {
    const first = await ready()

    resetToolchain()
    const second = await ready()

    expect(second).toBe(first)
    expect(setupCalls.count).toBe(1)
    // Recovered from the builder, not from this process's memory.
    expect(toolchainState().versions).toMatchObject({ java: '25.0.4.1', go: '1.26.0' })
  })

  it('is built by one builder, however many ask at once', async () => {
    await Promise.all([prepareToolchain(), prepareToolchain(), prepareToolchain()])
    expect(setupCalls.count).toBe(1)
  })

  it('does not count a snapshot from another region', async () => {
    await ready()

    env.SANDBOX_REGION = 'bom1'
    resetToolchain()
    await ready()

    // A different builder name, and a second build — snapshots cannot move.
    expect(setupCalls.count).toBe(2)
    expect(builderName()).toMatch(/-bom1$/)
  })

  it('fails with the end of the installer\'s output, and stops the builder', async () => {
    server.use(
      command(/^bash \/tmp\/syncspace-setup\.sh/, {
        stdout: 'Reading package lists...\n',
        stderr: 'E: Unable to locate package rustc\n',
        exitCode: 100,
      })
    )

    await expect(prepareToolchain()).rejects.toThrow(/Unable to locate package rustc/)

    const state = toolchainState()
    expect(state.status).toBe('failed')
    expect(state.reason).toMatch(/setup\.sh exited with 100/)

    const builder = await Sandbox.get({ name: builderName(), resume: false })
    expect(builder.status).not.toBe('running')
  })

  it('does not hammer a failure, but tries again once the window has passed', async () => {
    server.use(command(/^bash \/tmp\/syncspace-setup\.sh/, { stderr: 'E: network\n', exitCode: 100 }))
    await expect(prepareToolchain()).rejects.toThrow()

    // Inside the window: refused at once, without another builder.
    await expect(prepareToolchain()).rejects.toThrow(/could not be prepared/)
    expect(setupCalls.count).toBe(0)

    vi.spyOn(Date, 'now').mockReturnValue(toolchainState().failedAt + 6 * 60 * 1000)
    server.resetHandlers()
    await prepareToolchain()
    expect(toolchainState().status).toBe('ready')
  })

  it('removes a half-finished builder before starting another', async () => {
    // An earlier process got as far as starting a builder and no further.
    await Sandbox.create({ name: builderName(), region: 'sin1', persistent: false })

    await ready()
    expect(setupCalls.count).toBe(1)
  })

  /**
   * A builder cannot be called off — it is a machine somewhere installing
   * packages. So forgetting the toolchains has to mean not believing it when
   * it finishes, or an abandoned build lands minutes later and declares a
   * snapshot ready that nothing is waiting for any more.
   */
  it('does not let a build it was told to forget declare a snapshot ready', async () => {
    let finishSetup
    server.use(
      command(/^bash \/tmp\/syncspace-setup\.sh/, async () => {
        await new Promise((resolve) => {
          finishSetup = resolve
        })
        return { stdout: SETUP_OUTPUT, exitCode: 0 }
      })
    )

    const abandoned = prepareToolchain().catch(() => {})
    await vi.waitFor(() => expect(finishSetup).toBeTypeOf('function'))

    // Forgotten while its builder is still installing.
    resetToolchain()
    finishSetup()
    await abandoned

    expect(toolchainState()).toMatchObject({ status: 'idle', snapshotId: null })
  })

  /**
   * An account that may not keep a snapshot for ever should get one with
   * Vercel's default expiry, not a build thrown away at its very last step.
   */
  it('settles for the default expiry when "never" is refused', async () => {
    // The SDK's own class, which is what `Sandbox.create` hands back — the
    // mock's export only wraps its static methods.
    const probe = await Sandbox.create({ persistent: false })
    let proto = Object.getPrototypeOf(probe)
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'snapshot')) proto = Object.getPrototypeOf(proto)
    await probe.delete()

    const original = proto.snapshot
    const snapshot = vi.spyOn(proto, 'snapshot').mockImplementation(async function (options) {
      if (options?.expiration === 0) {
        throw Object.assign(new Error('Status code 400 is not ok: expiration not allowed'), {
          response: { status: 400 },
        })
      }
      return original.call(this, options)
    })

    await ready()

    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(snapshot.mock.calls[1][0]).toBeUndefined()
  })

  describe('from an earlier recipe', () => {
    const OLD = 'syncspace-toolchains-000000000000-sin1'

    async function oldBuilder() {
      const builder = await Sandbox.create({
        name: OLD,
        region: 'sin1',
        persistent: false,
        tags: { app: 'syncspace', role: 'toolchains', recipe: '000000000000' },
      })
      await builder.snapshot({ expiration: 0 })
    }

    /** Snapshots that never expire have to be removed by somebody, or they are kept for good. */
    it('is removed once nothing has used it for a week', async () => {
      await oldBuilder()
      await ready()

      const realNow = Date.now
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 8 * 24 * 60 * 60 * 1000)
      resetToolchain()
      await ready()

      await vi.waitFor(async () => {
        await expect(Sandbox.get({ name: OLD, resume: false })).rejects.toThrow()
      })
      // The current one is left alone.
      await expect(Sandbox.get({ name: builderName(), resume: false })).resolves.toBeTruthy()
    })

    /** It may be a staging server one version behind, still using it. */
    it('is kept while it may still be in use', async () => {
      await oldBuilder()
      await ready()
      resetToolchain()
      await ready()
      await sleep(50)

      await expect(Sandbox.get({ name: OLD, resume: false })).resolves.toBeTruthy()
    })
  })
})

describe('the versions tag', () => {
  it('keeps the version and drops the prose, within one tag', () => {
    const encoded = encodeVersions(parseVersions(SETUP_OUTPUT))
    expect(encoded.length).toBeLessThanOrEqual(256)
    expect(decodeVersions(encoded)).toEqual({
      javascript: '24.9.0',
      typescript: '24.9.0',
      python: '3.14.4',
      java: '25.0.4.1',
      cpp: '15.2.0-16ubuntu1',
      go: '1.26.0',
      rust: '1.93.1',
    })
  })
})

describe('what /runners says', () => {
  /**
   * The case the Run button has to get right on a first deploy: nothing is
   * wrong, the compilers are simply not there yet. "Not installed" would be
   * false, and remembering it would make it true for good.
   */
  it('says a language is on its way while the snapshot is built, and asks again', async () => {
    let finishSetup
    server.use(
      command(/^bash \/tmp\/syncspace-setup\.sh/, async () => {
        await new Promise((resolve) => {
          finishSetup = resolve
        })
        return { stdout: SETUP_OUTPUT, exitCode: 0 }
      })
    )

    const before = await listRunnable()
    const java = before.find((entry) => entry.language === 'java')
    expect(java).toMatchObject({ available: false, pending: true })
    expect(java.reason).toMatch(/being installed in the sandbox/)

    await vi.waitFor(() => expect(finishSetup).toBeTypeOf('function'))
    finishSetup()
    await prepareToolchain()

    const after = await listRunnable()
    expect(after.every((entry) => entry.available)).toBe(true)
    expect(after.find((entry) => entry.language === 'java').version).toMatch(/25\.0\.4/)
    expect(after.some((entry) => 'pending' in entry)).toBe(false)
  })

  it('says why, when the snapshot could not be built', async () => {
    server.use(command(/^bash \/tmp\/syncspace-setup\.sh/, { stderr: 'E: no space\n', exitCode: 1 }))
    await prepareToolchain().catch(() => {})

    const entries = await listRunnable()
    expect(entries[0]).toMatchObject({ available: false })
    expect(entries[0].pending).toBeUndefined()
    expect(entries[0].reason).toMatch(/^The sandbox toolchains could not be prepared/)
  })
})

describe('the isolation it reports', () => {
  it('enforces every control, and says so', () => {
    const isolation = describeIsolation('vercel')

    expect(isolation.weak).toBe(false)
    expect(isolation.unenforced).toEqual([])
  })

  /**
   * A VM comes in whole vCPUs with 2 GB each. Reporting SANDBOX_MEMORY_MB's
   * 256 here would be a limit the deployment does not keep.
   */
  it('reports the machine it really gets, not the numbers meant for Docker', () => {
    env.SANDBOX_CPUS = 0.5
    expect(resolveLimits('vercel')).toMatchObject({ cpus: 1, memoryMb: 2048 })

    env.SANDBOX_CPUS = 3
    expect(resolveLimits('vercel')).toMatchObject({ cpus: 4, memoryMb: 8192 })

    // Everyone else is untouched.
    expect(resolveLimits('docker').cpus).toBe(3)
  })

  it('sizes machines the way Vercel allows: one vCPU, or an even number', () => {
    expect([0.25, 1, 1.5, 2, 3, 4, 5].map(vcpusFor)).toEqual([1, 1, 2, 2, 4, 4, 6])
  })
})

describe('a run', () => {
  beforeEach(async () => {
    await ready()
  })

  it('boots a fresh machine from the snapshot, with no network, and never saves it', async () => {
    onStep(() => ({ stdout: 'hi\n' }))
    const create = vi.spyOn(Sandbox, 'create')

    await run('python', 'print("hi")')

    expect(create.mock.calls[0][0]).toMatchObject({
      source: { type: 'snapshot', snapshotId: toolchainState().snapshotId },
      networkPolicy: 'deny-all',
      persistent: false,
      region: 'sin1',
      resources: { vcpus: 1 },
      tags: { app: 'syncspace', role: 'run', language: 'python' },
    })
  })

  it('opens the network only when the deployment has turned it on', async () => {
    env.SANDBOX_NETWORK = true
    onStep(() => ({ stdout: '' }))
    const create = vi.spyOn(Sandbox, 'create')

    await run('python', 'pass')

    expect(create.mock.calls[0][0].networkPolicy).toBe('allow-all')
  })

  it('hands over the source and the input, and runs the language\'s own command', async () => {
    let seen = null
    onStep(async (args, ctx) => {
      seen = {
        args,
        source: (await ctx.exec('cat', ['/tmp/syncspace/src/main.py'])).stdout,
        stdin: (await ctx.exec('cat', ['/tmp/syncspace/stdin'])).stdout,
      }
      return { stdout: 'hello Sinchal\n' }
    })

    const result = await run('python', 'print("hello", input())', { stdin: 'Sinchal' })

    expect(seen.source).toBe('print("hello", input())')
    expect(seen.stdin).toBe('Sinchal')
    expect(seen.args).toEqual([
      '/tmp/syncspace/run.sh',
      'step',
      '5.000',
      String(env.SANDBOX_PIDS),
      String(env.SANDBOX_FILE_SIZE_MB * 1024 * 1024),
      '--',
      'python3',
      '-u',
      'main.py',
    ])

    expect(result).toMatchObject({
      stage: 'run',
      stdout: 'hello Sinchal\n',
      exitCode: 0,
      timedOut: false,
      truncated: false,
      termination: TERMINATION.EXITED,
    })
  })

  it('leaves nothing running afterwards', async () => {
    onStep(() => ({ stdout: 'done\n' }))

    await run('javascript', 'console.log("done")')

    expect(await runSandboxes()).toEqual([])
  })

  it('compiles, then runs the result in the same machine', async () => {
    const steps = []
    onStep((args) => {
      steps.push(args.slice(6))
      return args[6] === 'g++' ? {} : { stdout: 'compiled\n' }
    })

    const result = await run('cpp', 'int main() {}')

    expect(steps).toEqual([
      ['g++', '-std=c++17', 'main.cpp', '-o', 'program'],
      ['/work/program'],
    ])
    // The compiler gets twice the run's time.
    expect(result).toMatchObject({ stage: 'run', stdout: 'compiled\n', exitCode: 0 })
  })

  it('stops at a compile error and says that is where it stopped', async () => {
    const steps = []
    onStep((args) => {
      steps.push(args[6])
      return { stderr: "main.cpp:1:21: error: 'x' was not declared in this scope\n", exitCode: 1 }
    })

    const result = await run('cpp', 'int main() { return x; }')

    expect(steps).toEqual(['g++'])
    expect(result).toMatchObject({ stage: 'compile', exitCode: 1 })
    expect(result.stderr).toMatch(/not declared/)
    expect(await runSandboxes()).toEqual([])
  })

  it('passes a failing exit code and its stderr straight through', async () => {
    onStep(() => ({ stdout: 'to stdout\n', stderr: 'to stderr\n', exitCode: 3 }))

    const result = await run('python', 'raise SystemExit(3)')

    expect(result).toMatchObject({ exitCode: 3, stdout: 'to stdout\n', stderr: 'to stderr\n' })
    expect(result.termination).toBe(TERMINATION.EXITED)
  })

  /**
   * run.sh's `timeout` ends the program at the deadline: 124 when TERM was
   * enough, 137 when it took KILL a second later. Either is a timeout only if
   * the deadline had really passed.
   */
  it('reports a program the script stopped at its deadline as timed out', async () => {
    env.RUN_TIMEOUT_MS = 200
    onStep(async () => {
      await sleep(260)
      return { stdout: 'before\n', exitCode: 124 }
    })

    const result = await run('python', 'while True: pass')

    expect(result).toMatchObject({
      timedOut: true,
      termination: TERMINATION.TIMEOUT,
      exitCode: null,
      signal: 'SIGTERM',
      stdout: 'before\n',
    })
  })

  it('does not call a program that merely exits with 124 a timeout', async () => {
    onStep(() => ({ exitCode: 124 }))

    const result = await run('python', 'raise SystemExit(124)')

    expect(result).toMatchObject({ timedOut: false, exitCode: 124, termination: TERMINATION.EXITED })
  })

  it('gives up on a machine that stops answering, and says the program timed out', async () => {
    env.RUN_TIMEOUT_MS = 100
    const previous = vercel.setBackstopForTests(100)
    onStep(async () => {
      await sleep(2000)
      return { exitCode: 0 }
    })

    try {
      const started = Date.now()
      const result = await run('python', 'import time; time.sleep(60)')

      expect(Date.now() - started).toBeLessThan(1500)
      expect(result).toMatchObject({ timedOut: true, termination: TERMINATION.TIMEOUT, exitCode: null })
    } finally {
      vercel.setBackstopForTests(previous)
    }
  })

  it('stops a program that prints past the budget, keeping what fits', async () => {
    env.RUN_OUTPUT_LIMIT = 100
    onStep(() => ({ stdout: 'x'.repeat(5000) }))

    const result = await run('python', 'while True: print("x")')

    expect(result.truncated).toBe(true)
    expect(result.termination).toBe(TERMINATION.OUTPUT)
    expect(result.stdout.length).toBe(100)
    // Ended by this side, not left to finish: the budget is a limit on the
    // run, not only on the transcript.
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL' })
    expect(await runSandboxes()).toEqual([])
  })

  /** 137 is also what a program killing itself looks like; the kernel knows which. */
  it('asks the machine whether a SIGKILL was for memory', async () => {
    onStep(() => ({ stdout: 'allocating\n', exitCode: 137 }))
    onOomCheck(0)

    const result = await run('python', 'x = [bytearray(1 << 30) for _ in range(9)]')

    expect(result).toMatchObject({ oomKilled: true, termination: TERMINATION.MEMORY, exitCode: 137 })
  })

  it('does not blame memory for a SIGKILL the kernel did not send', async () => {
    onStep(() => ({ exitCode: 137 }))
    onOomCheck(1)

    const result = await run('python', 'import os, signal; os.kill(os.getpid(), signal.SIGKILL)')

    expect(result.oomKilled).toBeUndefined()
    expect(result).toMatchObject({ exitCode: 137, termination: TERMINATION.EXITED })
  })

  it('stops at once when cancelled, rather than when the program finishes', async () => {
    onStep(async () => {
      await sleep(2000)
      return { stdout: 'too late\n' }
    })

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)

    const started = Date.now()
    const result = await run('python', 'import time; time.sleep(60)', { signal: controller.signal })

    expect(Date.now() - started).toBeLessThan(1500)
    expect(result).toMatchObject({ cancelled: true, termination: TERMINATION.CANCELLED, exitCode: null })
    expect(await runSandboxes()).toEqual([])
  })

  it('never starts a machine for a run cancelled while it waited', async () => {
    const create = vi.spyOn(Sandbox, 'create')
    const controller = new AbortController()
    controller.abort()

    const result = await run('python', 'print(1)', { signal: controller.signal })

    expect(result).toMatchObject({ cancelled: true })
    expect(create).not.toHaveBeenCalled()
  })

  /**
   * Somebody can delete the snapshot from the dashboard. The run that finds
   * out cannot wait minutes for a rebuild — but it says what is happening,
   * and the next run should not fail the same way.
   */
  it('rebuilds a snapshot that has disappeared', async () => {
    const lost = toolchainState().snapshotId
    await (await Snapshot.get({ snapshotId: lost })).delete()

    await expect(run('python', 'print(1)')).rejects.toMatchObject({
      status: 503,
      code: 'sandbox_unavailable',
    })

    await prepareToolchain()
    expect(toolchainState()).toMatchObject({ status: 'ready' })
    expect(toolchainState().snapshotId).not.toBe(lost)
    expect(setupCalls.count).toBe(2)
  })
})

describe('a run before the snapshot exists', () => {
  it('is refused with a reason, rather than left waiting minutes for apt', async () => {
    let finishSetup
    server.use(
      command(/^bash \/tmp\/syncspace-setup\.sh/, async () => {
        await new Promise((resolve) => {
          finishSetup = resolve
        })
        return { stdout: SETUP_OUTPUT }
      })
    )
    prepareToolchain().catch(() => {})
    await vi.waitFor(() => expect(finishSetup).toBeTypeOf('function'))

    await expect(run('python', 'print(1)')).rejects.toMatchObject({
      status: 503,
      code: 'sandbox_preparing',
      message: expect.stringContaining('still being set up'),
    })

    finishSetup()
    await prepareToolchain()
  })
})

describe('through the queue', () => {
  it('records which backend ran it, and returns what the room is shown', async () => {
    await ready()
    onStep(() => ({ stdout: 'Hello, World! from stdin\n' }))

    const payload = await runCode({
      language: 'java',
      code: 'public class HelloWorld { public static void main(String[] a) {} }',
      stdin: 'from stdin',
      room: 'room-vercel',
      user: { id: null, name: 'Sinchal' },
    })

    expect(payload).toMatchObject({
      language: 'java',
      ok: true,
      stdout: 'Hello, World! from stdin\n',
      backend: 'vercel',
      state: 'completed',
      termination: TERMINATION.EXITED,
    })
  })

  it('turns a machine that could not start into a clear failure', async () => {
    await ready()
    vi.spyOn(Sandbox, 'create').mockRejectedValueOnce(
      Object.assign(new Error('Status code 402 is not ok: Sandbox creation paused'), {
        response: { status: 402 },
      })
    )

    await expect(
      runCode({ language: 'python', code: 'print(1)', room: 'room-vercel', user: { id: null, name: 'Sinchal' } })
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('used its sandbox allowance'),
    })
  })
})

describe('housekeeping', () => {
  it('deletes run machines an earlier process left behind, and only old ones', async () => {
    const old = await Sandbox.create({ tags: { app: 'syncspace', role: 'run' }, persistent: false })
    const fresh = await Sandbox.create({ tags: { app: 'syncspace', role: 'run' }, persistent: false })
    const stranger = await Sandbox.create({ tags: { app: 'something-else', role: 'run' }, persistent: false })

    const realNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 11 * 60 * 1000)
    vi.spyOn(Sandbox, 'list').mockImplementation(async () => ({
      sandboxes: [
        { name: old.name, createdAt: realNow() - 60 * 60 * 1000, tags: { app: 'syncspace', role: 'run' } },
        { name: fresh.name, createdAt: realNow() + 11 * 60 * 1000, tags: { app: 'syncspace', role: 'run' } },
        { name: stranger.name, createdAt: realNow() - 60 * 60 * 1000, tags: { app: 'something-else', role: 'run' } },
      ],
    }))

    expect(await vercel.reap()).toBe(1)
    await expect(Sandbox.get({ name: old.name, resume: false })).rejects.toThrow()
    await expect(Sandbox.get({ name: fresh.name, resume: false })).resolves.toBeTruthy()
    await expect(Sandbox.get({ name: stranger.name, resume: false })).resolves.toBeTruthy()
  })
})
