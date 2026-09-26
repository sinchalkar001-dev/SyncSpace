import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import { env } from '../../../config/env.js'
import { logger } from '../../../config/logger.js'
import { unavailable } from '../../../errors.js'
import { TERMINATION, vcpusFor } from '../limits.js'
import { containerContext } from '../recipes.js'
import { identity } from '../redact.js'
import { codeOf, credentials, describeError, loadSdk, missingCredentials, statusOf } from './vercel/sdk.js'
import {
  APP_TAG,
  forgetSnapshot,
  prepareToolchain,
  resetToolchain,
  toolchainState,
} from './vercel/toolchain.js'

/**
 * A microVM per run, on Vercel Sandbox.
 *
 * For a host with no container runtime to hand — Render's free plan, most
 * platforms that run a Node process and nothing else — where the choice used
 * to be between running code unsandboxed and not running it at all. The
 * isolation moves off the machine instead: each run gets a Firecracker VM of
 * its own, booted from a snapshot that already has the toolchains, with no
 * route to the internet, and deleted as soon as the run is over.
 *
 * Nothing about the server is inside that VM. No filesystem, no environment,
 * no network path back — the program cannot read MONGODB_URI because it is
 * running on a different computer that has never heard of it. That is why
 * every control in the enforcement table is real here, including the ones the
 * process backend has to admit it cannot keep.
 *
 * The cost is time. A VM takes a few seconds to come up, and that happens on
 * every press of Run: the machine is not reused, for the same reason the
 * Docker backend does not reuse containers. "Cleanup after execution" only
 * means something if there is nothing left to clean.
 */

export const name = 'vercel'

/**
 * What it can run changes while the server is up — the snapshot is built
 * after start, and rebuilt if it disappears — so its answers are not cached.
 * They come from memory; asking is free.
 */
export const answersChange = true

const RUN_SCRIPT = readFileSync(new URL('./vercel/run.sh', import.meta.url), 'utf8')

/** Where the script, the source and the input are uploaded. Root-owned from the program's point of view. */
const STAGING = '/tmp/syncspace'

/** Where the program runs; run.sh makes it, for nobody. */
const MOUNT = '/work'

/**
 * Past the program's own deadline, how long before this side gives up waiting.
 *
 * The script inside the VM is what ends a program on time — TERM at the
 * deadline, KILL a second later. This is only for a VM that stops answering
 * altogether, so it is generous: stopping early here would report a program
 * as timed out when it was the network that was slow.
 */
let BACKSTOP_MS = 10 * 1000

/**
 * How long a VM may live, whatever happens to this server.
 *
 * Each run deletes its VM on the way out. This is for the run that cannot — a
 * crash, a deploy mid-run — so it is the compile and run budgets plus a
 * minute for booting and uploading, and not a second more.
 */
const LIFETIME_GRACE_MS = 60 * 1000

/** Older than this, a run's VM is left over from a process that is gone. */
const REAP_AFTER_MS = 10 * 60 * 1000

/**
 * The most that starting a VM and handing it the program may take.
 *
 * The first request to a new VM also waits for it to finish booting, which is
 * usually a second or two and occasionally much more. Past this it is not
 * coming, and a run must not hold its queue slot waiting for it.
 */
const BOOT_TIMEOUT_MS = 60 * 1000

/** Test seam: how long to wait past a deadline before giving up on the VM. */
export function setBackstopForTests(ms) {
  const previous = BACKSTOP_MS
  BACKSTOP_MS = ms
  return previous
}

/** Whether this server has a Vercel account to put sandboxes in. */
export async function available() {
  return Boolean(credentials())
}

/**
 * Whether runs can be sent to Vercel at all.
 *
 * Credentials and a loadable SDK, and nothing slower: the toolchain snapshot
 * may take minutes to build on a first start, and that is a reason for
 * individual languages to say "not yet" — not for the whole feature to be
 * refused for the life of the process. Asking also starts the snapshot on its
 * way, so the first person to open a room is not the one who waits for it.
 */
export async function readiness() {
  const missing = missingCredentials()

  if (missing.length) {
    return {
      ok: false,
      reason:
        missing.join(', ') +
        (missing.length === 1 ? ' is' : ' are') +
        ' not set, so there is no Vercel account to start sandboxes in',
    }
  }

  try {
    await loadSdk()
  } catch (error) {
    return { ok: false, reason: 'the @vercel/sandbox package could not be loaded (' + error.message + ')' }
  }

  prepareToolchain().catch(() => {
    // Recorded in the toolchain state and logged there; /runners reports it.
  })

  return { ok: true, reason: null }
}

/** Test seam, and what the backend cache reset calls. */
export function resetAvailabilityCache() {
  resetToolchain()
}

/**
 * Whether a language can run yet.
 *
 * All seven or none: they share one snapshot. While it is being built every
 * language is `pending`, which is what tells the interface to ask again
 * rather than decide the server simply lacks a compiler.
 */
export async function probe(recipe, { language } = {}) {
  let toolchain = toolchainState()

  if (toolchain.status !== 'ready') {
    // Starts it, or retries a failure once the retry window has passed.
    prepareToolchain().catch(() => {})
    toolchain = toolchainState()
  }

  if (toolchain.status === 'ready') {
    return {
      available: true,
      version: toolchain.versions?.[language] || recipe.toolchain + ' (Vercel Sandbox)',
    }
  }

  if (toolchain.status === 'failed') {
    return { available: false, version: '', reason: capitalise(toolchain.reason) }
  }

  return {
    available: false,
    pending: true,
    version: '',
    reason:
      recipe.toolchain +
      ' is being installed in the sandbox. This happens once, on the first start, and takes a few minutes.',
  }
}

/**
 * Deletes VMs that runs of an earlier process left behind.
 *
 * Every run deletes its own, and a VM stops itself at the end of its lifetime
 * either way, so this is housekeeping rather than safety: what it removes is
 * the record of a stopped machine, which would otherwise sit in the Vercel
 * dashboard for ever. Only old ones — a run in flight elsewhere is not an
 * orphan.
 */
export async function reap() {
  const creds = credentials()
  if (!creds) return 0

  const sdk = await loadSdk()
  const signal = AbortSignal.timeout(30 * 1000)
  const page = await sdk.Sandbox.list({ ...creds, tags: { role: 'run' }, limit: 50, signal })

  let removed = 0
  for (const sandbox of page.sandboxes ?? []) {
    if (sandbox.tags?.app !== APP_TAG) continue
    if (Date.now() - sandbox.createdAt < REAP_AFTER_MS) continue

    try {
      const found = await sdk.Sandbox.get({ ...creds, name: sandbox.name, resume: false, signal })
      await found.delete({ signal })
      removed += 1
    } catch (error) {
      logger.warn({ err: error, sandbox: sandbox.name }, 'could not remove a leftover run sandbox')
    }
  }

  if (removed) logger.info({ count: removed }, 'removed leftover run sandboxes')
  return removed
}

/**
 * Settles with `promise`, or rejects the moment `signal` aborts.
 *
 * Every step of a run is a network call, and a Cancel pressed while one is in
 * flight should end the run now rather than whenever that call gets round to
 * noticing. The VM is deleted either way on the way out, which is what really
 * stops the program.
 */
function untilAborted(promise, signal) {
  if (!signal) return promise

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    if (signal.aborted) return onAbort()

    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/**
 * Whether the program that just died of SIGKILL was killed for memory.
 *
 * 137 is what both an out-of-memory kill and a program killing itself look
 * like. The VM has run one program, so the kernel's log answers the question
 * without ambiguity. Asked only in that one case, since it is another round
 * trip.
 */
async function wasOutOfMemory(sandbox) {
  try {
    const check = await sandbox.runCommand({
      cmd: 'bash',
      args: [STAGING + '/run.sh', 'oom'],
      sudo: true,
      signal: AbortSignal.timeout(15 * 1000),
    })
    return check.exitCode === 0
  } catch {
    return false
  }
}

/**
 * One compile or run step, with the same guarantees `spawnCollect` gives a
 * local process: a deadline, an output budget that ends the program rather
 * than only the transcript, and cancellation — all of which resolve into a
 * result rather than an exception.
 *
 * The one thing that does throw is the VM itself failing: a lost connection,
 * a sandbox that stopped under us. That is not a property of the program and
 * is not reported as one.
 */
async function step(sandbox, { command, args, timeoutMs, limits, signal, redact }) {
  const started = Date.now()
  const controller = new AbortController()

  let stdout = ''
  let stderr = ''
  let truncated = false
  let timedOut = false
  let cancelled = false
  let stopped = false

  const stop = (reason) => {
    if (stopped) return
    stopped = true
    controller.abort(new Error(reason))
  }

  const collect = (which) =>
    new Writable({
      decodeStrings: false,
      write(chunk, _encoding, done) {
        if (stopped) return done()

        const text = String(chunk)
        const room = limits.outputBytes - (stdout.length + stderr.length)

        if (text.length > room) {
          truncated = true
          const kept = text.slice(0, Math.max(0, room))
          if (which === 'out') stdout += kept
          else stderr += kept
          // As with a local process: past the budget the program is stopped,
          // not merely ignored. It would otherwise print for the rest of its
          // time limit into a stream nobody reads.
          stop('output limit')
          return done()
        }

        if (which === 'out') stdout += text
        else stderr += text
        done()
      },
    })

  const onAbort = () => {
    cancelled = true
    stop('cancelled')
  }
  if (signal?.aborted) onAbort()
  signal?.addEventListener('abort', onAbort, { once: true })

  const backstop = setTimeout(() => {
    timedOut = true
    stop('deadline')
  }, timeoutMs + BACKSTOP_MS)

  let finished = null
  let failure = null

  try {
    if (!stopped) {
      finished = await untilAborted(
        sandbox.runCommand({
          cmd: 'bash',
          args: [
            STAGING + '/run.sh',
            'step',
            (timeoutMs / 1000).toFixed(3),
            String(limits.processes),
            String(limits.fileSizeMb * 1024 * 1024),
            '--',
            command,
            ...args,
          ],
          sudo: true,
          stdout: collect('out'),
          stderr: collect('err'),
          signal: controller.signal,
        }),
        controller.signal
      )
    }
  } catch (error) {
    // Our own abort is an outcome. Anything else is the VM failing.
    if (!stopped) failure = error
  } finally {
    clearTimeout(backstop)
    signal?.removeEventListener('abort', onAbort)
  }

  if (failure) {
    throw unavailable(
      'The sandbox stopped answering during this run: ' + describeError(failure),
      'sandbox_unavailable'
    )
  }

  const durationMs = typeof finished?.durationMs === 'number' ? finished.durationMs : Date.now() - started
  let exitCode = finished ? finished.exitCode : null
  let signalName = null

  // run.sh hands back 124 when TERM ended the program at its deadline, and
  // 137 when it took KILL. Both mean "timed out" only if the deadline had
  // actually passed: a program is entitled to exit 124 on its own.
  if (finished && (exitCode === 124 || exitCode === 137) && durationMs >= timeoutMs) {
    timedOut = true
  }

  const oomKilled = Boolean(finished) && exitCode === 137 && !timedOut && (await wasOutOfMemory(sandbox))

  if (timedOut || cancelled || (truncated && !finished)) {
    signalName = exitCode === 124 ? 'SIGTERM' : 'SIGKILL'
    exitCode = null
  }

  const termination = cancelled
    ? TERMINATION.CANCELLED
    : timedOut
      ? TERMINATION.TIMEOUT
      : truncated
        ? TERMINATION.OUTPUT
        : oomKilled
          ? TERMINATION.MEMORY
          : TERMINATION.EXITED

  return {
    stdout: redact(stdout),
    stderr: redact(stderr),
    truncated,
    timedOut,
    cancelled,
    termination,
    durationMs,
    exitCode,
    signal: signalName,
    ...(oomKilled ? { oomKilled: true } : {}),
  }
}

/** What a run that was stopped before it began looks like. */
const notStarted = () => ({
  stage: 'run',
  stdout: '',
  stderr: '',
  truncated: false,
  timedOut: false,
  cancelled: true,
  termination: TERMINATION.CANCELLED,
  durationMs: 0,
  exitCode: null,
  signal: null,
})

/**
 * Deletes the VM, and everything the program started with it.
 *
 * Not conditional on anything: a run that timed out, was cancelled or hit its
 * output budget still has a live program in there, and this is what actually
 * ends it. If the delete fails the stop is tried instead, and if that fails
 * too the VM's own lifetime ends it a minute or so later.
 */
async function discard(sandbox) {
  try {
    await sandbox.delete({ signal: AbortSignal.timeout(15 * 1000) })
  } catch (error) {
    logger.warn({ err: error, sandbox: sandbox.name }, 'could not delete a run sandbox; stopping it instead')
    await sandbox.stop({ signal: AbortSignal.timeout(15 * 1000) }).catch(() => {})
  }
}

export async function execute({ recipe, language, workDir, source, stdin, limits, signal, executionId }) {
  const toolchain = toolchainState()

  if (toolchain.status !== 'ready') {
    prepareToolchain().catch(() => {})

    throw unavailable(
      toolchain.status === 'failed'
        ? capitalise(toolchain.reason)
        : 'The sandbox is still being set up — this happens once, on the first start. Try again in a few minutes.',
      'sandbox_preparing'
    )
  }

  if (signal?.aborted) return notStarted()

  const creds = credentials()
  const sdk = await loadSdk()
  const code = source ?? (await readFile(path.join(workDir, recipe.file), 'utf8'))

  let sandbox
  try {
    sandbox = await sdk.Sandbox.create({
      ...creds,
      source: { type: 'snapshot', snapshotId: toolchain.snapshotId },
      region: env.SANDBOX_REGION,
      resources: { vcpus: vcpusFor(limits.cpus) },
      timeout: limits.compileTimeoutMs + limits.timeoutMs + LIFETIME_GRACE_MS,
      // Off unless a deployment deliberately turned it on, as with Docker.
      networkPolicy: limits.network ? 'allow-all' : 'deny-all',
      // A run's filesystem is worth nothing afterwards; saving it would only
      // fill the account's snapshot storage with other people's programs.
      persistent: false,
      tags: { app: APP_TAG, role: 'run', language, execution: executionId },
      // A deadline, but not the run's cancellation: abandoning a create the
      // API has already acted on would leave a VM nobody is going to delete.
      signal: AbortSignal.timeout(BOOT_TIMEOUT_MS),
    })
  } catch (error) {
    if (codeOf(error) === 'snapshot_not_found' || statusOf(error) === 404) {
      forgetSnapshot(toolchain.snapshotId)
    }

    throw unavailable('Could not start a sandbox for this run: ' + describeError(error), 'sandbox_unavailable')
  }

  // Nothing is redacted, and that is not an oversight. Redaction exists to
  // keep this server's paths, account and hostname out of a stranger's
  // console, and none of them can be printed by a program running on a
  // different machine. What it would still do is rewrite the program's own
  // output wherever it happened to contain one of those strings, and an
  // account name is very often also an ordinary word. Paths read as
  // `/work/main.js`, exactly as they do under Docker.
  const redact = identity
  const context = containerContext(MOUNT)
  const shared = { limits, signal, redact }

  try {
    const upload = AbortSignal.any([AbortSignal.timeout(BOOT_TIMEOUT_MS), ...(signal ? [signal] : [])])

    try {
      await untilAborted(
        sandbox.writeFiles(
          [
            { path: STAGING + '/run.sh', content: RUN_SCRIPT, mode: 0o755 },
            { path: STAGING + '/src/' + recipe.file, content: code },
            { path: STAGING + '/stdin', content: stdin ?? '' },
          ],
          { signal: upload }
        ),
        upload
      )
    } catch (error) {
      if (signal?.aborted) return notStarted()
      throw unavailable('Could not hand the program to its sandbox: ' + describeError(error), 'sandbox_unavailable')
    }

    if (recipe.compile) {
      const [command, args] = recipe.compile(context)
      const compiled = await step(sandbox, { ...shared, command, args, timeoutMs: limits.compileTimeoutMs })

      if (compiled.exitCode !== 0 || compiled.timedOut || compiled.cancelled || compiled.truncated) {
        return { stage: 'compile', ...compiled }
      }
    }

    const [command, args] = recipe.run(context)
    const result = await step(sandbox, { ...shared, command, args, timeoutMs: limits.timeoutMs })

    return { stage: 'run', ...result }
  } finally {
    await discard(sandbox)
  }
}

function capitalise(text) {
  const value = String(text || '')
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export { TERMINATION }
