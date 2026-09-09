import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import mongoose from 'mongoose'
import { AppError, badRequest, forbidden, notFound } from '../errors.js'
import { env } from '../config/env.js'
import { ACTIVITY, recordActivity } from './activity.service.js'
import { logger } from '../config/logger.js'
import { Execution } from '../models/Execution.js'
import { getIo } from '../realtime/registry.js'
import { activeBackendName, requireBackend } from './execution/backend.js'
import { describeIsolation, isTerminal, resolveLimits, TERMINATION } from './execution/limits.js'
import { createExecutionQueue } from './execution/queue.js'
import { createRedactor } from './execution/redact.js'
import { RECIPES, RUNNABLE_LANGUAGES } from './execution/recipes.js'

/**
 * Client → API → job → queue → isolated runner → sandbox → result → room.
 *
 * This module is the middle of that sentence. It owns the throwaway directory
 * (so that cleanup is in one place regardless of which backend ran), the
 * durable record, and the announcements to the room; the backend owns the
 * isolation and the queue owns the waiting.
 *
 * Everything here is written so a run has a name before it has a process. That
 * is what cancellation needs, what the room timeline needs, and what makes
 * "who ran the thing that took the server down" a question with an answer.
 */

const sourceHashOf = (code) => createHash('sha256').update(code, 'utf8').digest('hex')

/**
 * Who a run belongs to, for the queue's purposes.
 *
 * Guests have no id, so the name they are running under is what keeps two of
 * them apart. It is a weak key and deliberately so — a guest limit is a speed
 * bump, and the real budget for anonymous callers is the per-IP rate limiter
 * above it. What matters is that this is computed the same way when a run
 * starts and when somebody tries to stop it: the two disagreeing is how a
 * guest ends up unable to cancel their own program.
 */
const ownerKeyFor = (user) => user?.id ?? 'guest:' + (user?.name ?? 'anonymous')

const caps = () => ({
  concurrent: env.RUN_MAX_CONCURRENT,
  perUser: env.SANDBOX_MAX_PER_USER,
  perRoom: env.SANDBOX_MAX_PER_ROOM,
  queueDepth: env.SANDBOX_QUEUE_DEPTH,
})

/**
 * Tells the room where a run has got to.
 *
 * Every member, not only whoever pressed the button: the buffer is shared, so
 * a console that only lit up for one person would leave everyone else
 * wondering why the code they are reading just printed something. This is the
 * event the Cancel button hangs off too — it is how a client learns the id of
 * a run that has not finished yet.
 */
function announce(job, extra = {}) {
  getIo()
    ?.to(job.roomId)
    .emit('execution:state', {
      roomId: job.roomId,
      executionId: job.executionId,
      // The client's own id for the run, so it can match a broadcast to the
      // button it is holding.
      runId: job.payload?.runId ?? null,
      state: job.state,
      termination: job.termination,
      by: job.user,
      language: job.language,
      durationMs: job.durationMs,
      ...extra,
    })
}

/**
 * Runs one job: a directory, a source file, a backend, and then nothing left
 * behind.
 */
async function runJob(job, signal) {
  const backend = await requireBackend()
  const recipe = RECIPES[job.language]
  const limits = resolveLimits()

  const dir = await mkdtemp(path.join(os.tmpdir(), 'syncspace-run-'))
  // Built from the directory this run actually got, so the rewriting is exact
  // rather than a guess at what a temp path looks like.
  const redact = createRedactor({ workDir: dir })

  job.backend = backend.name

  try {
    await writeFile(path.join(dir, recipe.file), job.payload.code, 'utf8')

    const result = await backend.execute({
      recipe,
      language: job.language,
      workDir: dir,
      stdin: job.payload.stdin ?? '',
      limits,
      signal,
      redact,
      executionId: job.executionId,
    })

    if (result.failedToStart) {
      throw new AppError(
        501,
        (recipe.toolchain || job.language) +
          ' is not installed on the server, so ' +
          job.language +
          ' cannot run here',
        'toolchain_missing'
      )
    }

    return result
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((error) => {
      logger.warn({ err: error }, 'could not remove a run directory')
    })
  }
}

/** Written on every transition, so a crash cannot lose a run that mattered. */
async function persist(job) {
  // Running code does not depend on the database being up. Without this,
  // Mongoose buffers the write and resolves it ten seconds later against a
  // connection that is not coming back, holding the transition open — a
  // database outage would turn every run into a timeout.
  if (mongoose.connection.readyState !== 1) return

  const retentionMs = env.SANDBOX_RETENTION_HOURS * 3600 * 1000
  const result = job.result

  const update = {
    executionId: job.executionId,
    roomId: job.roomId,
    user: job.user?.id && mongoose.isValidObjectId(job.user.id) ? job.user.id : null,
    userName: job.user?.name ?? null,
    language: job.language,
    sourceHash: job.sourceHash,
    sourceBytes: Buffer.byteLength(job.payload?.code ?? '', 'utf8'),
    state: job.state,
    termination: job.termination,
    backend: job.backend ?? null,
    stage: result?.stage ?? null,
    queuedAt: new Date(job.queuedAt),
    startedAt: job.startedAt ? new Date(job.startedAt) : null,
    finishedAt: job.finishedAt ? new Date(job.finishedAt) : null,
    durationMs: result?.durationMs ?? job.durationMs ?? 0,
    exitCode: typeof result?.exitCode === 'number' ? result.exitCode : null,
    signal: result?.signal ?? null,
    stdout: result?.stdout ?? '',
    stderr: result?.stderr ?? '',
    truncated: Boolean(result?.truncated),
    expiresAt: new Date(Date.now() + retentionMs),
  }

  await Execution.findOneAndUpdate({ executionId: job.executionId }, update, {
    upsert: true,
    new: true,
  }).catch((error) => {
    // A run that worked must not fail because the record of it did not.
    logger.warn({ err: error, executionId: job.executionId }, 'could not record an execution')
  })
}

/**
 * Tells the room's feed that a run finished.
 *
 * Only the last transition, and never collapsed: two runs a second apart are
 * two answers, and folding them together would hide whichever one failed -
 * which is invariably the one somebody wanted to know about.
 */
function noteFinished(job) {
  if (!isTerminal(job.state)) return

  const outcome =
    job.state === 'completed'
      ? job.language + ' ran cleanly'
      : job.language + ' run ' + String(job.state).replace('_', ' ')

  recordActivity({
    roomId: job.roomId,
    kind: ACTIVITY.EXECUTION_COMPLETED,
    actor: job.user?.id ?? null,
    actorName: job.user?.name ?? null,
    detail: outcome,
  })
}

const queue = createExecutionQueue({
  run: runJob,
  caps,
  onState: (job) => {
    announce(job)
    persist(job)
    noteFinished(job)
  },
})

/** Test seam: abandons everything in flight. */
export function resetQueue() {
  queue.clear()
}

export const queueStats = () => queue.stats()

/**
 * The shape the room has always been sent, kept exactly.
 *
 * The client renders this and so does the e2e suite; adding fields is safe and
 * removing one is not. The new information rides alongside rather than
 * replacing anything.
 */
function toRunPayload(job) {
  const result = job.result ?? {}

  return {
    language: job.language,
    stage: result.stage ?? 'run',
    ok: job.state === 'completed',
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    truncated: Boolean(result.truncated),
    timedOut: Boolean(result.timedOut),
    durationMs: result.durationMs ?? job.durationMs ?? 0,
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    signal: result.signal ?? null,

    // Added by the isolation work; nothing above changed shape.
    executionId: job.executionId,
    state: job.state,
    termination: job.termination,
    backend: job.backend ?? null,
    sourceHash: job.sourceHash,
  }
}

function assertRunnable(language) {
  if (!env.ALLOW_CODE_EXECUTION) {
    throw forbidden('Running code is switched off on this server', 'execution_disabled')
  }

  if (!RUNNABLE_LANGUAGES.includes(language)) {
    throw badRequest(
      language + ' has no runner here — it can be edited and shared, but not run',
      'language_not_runnable'
    )
  }
}

/**
 * Queues a run and waits for it.
 *
 * The waiting is the caller's choice, not this function's: `startExecution`
 * hands back the job so a route can answer immediately if it would rather.
 */
export async function runCode({ language, code, stdin = '', room, user, runId }) {
  const job = await startExecution({ language, code, stdin, room, user, runId })
  await job.done

  if (job.error) throw job.error

  return toRunPayload(job)
}

export async function startExecution({ language, code, stdin = '', room, user, runId }) {
  assertRunnable(language)

  // Resolved before anything is queued: a server configured for containers
  // with no container runtime should refuse here, not four seconds later.
  await requireBackend()

  return queue.submit({
    roomId: room ?? 'adhoc',
    userKey: ownerKeyFor(user),
    user: user ?? null,
    language,
    sourceHash: sourceHashOf(code),
    payload: { code, stdin, runId: runId ?? null },
  })
}

/**
 * Stops a run.
 *
 * `canCancelAnything` is the room owner's escape hatch: whoever started a
 * program is normally the one who stops it, but somebody has to be able to end
 * a run in their own room without waiting out the timeout.
 */
export async function cancelExecution({ executionId, user, canCancelAnything = false }) {
  const job = queue.get(executionId)

  if (!job) {
    const record = await Execution.findOne({ executionId }).lean()
    if (!record) throw notFound('No such execution', 'execution_not_found')
    // Already over. Not an error: a Cancel pressed as the program exits is a
    // race, and an error for winning it would be nonsense.
    return { cancelled: false, state: record.state }
  }

  // Asked before ownership, because a finished run is not something anybody
  // is cancelling. Refusing a stranger permission to stop a program that
  // stopped by itself is a true statement and a confusing one.
  if (isTerminal(job.state)) return { cancelled: false, state: job.state }

  if (!canCancelAnything && job.userKey !== ownerKeyFor(user)) {
    throw forbidden('You can only stop a program you started', 'execution_forbidden')
  }

  const cancelled = queue.cancel(executionId, canCancelAnything ? {} : { userKey: ownerKeyFor(user) })

  return { cancelled, state: queue.get(executionId)?.state ?? 'cancelled' }
}

export async function getExecution(executionId) {
  const record = await Execution.findOne({ executionId })
  if (!record) throw notFound('No such execution', 'execution_not_found')
  return record.toPublic()
}

/** A room's recent runs, newest first — what the console reloads into. */
export async function listExecutions(roomId, { limit = 20 } = {}) {
  const capped = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100)

  const records = await Execution.find({ roomId }).sort({ createdAt: -1 }).limit(capped)
  return records.map((record) => record.toPublic())
}

/** What `/runners` reports about the isolation in force. */
export async function isolationStatus() {
  const backend = await activeBackendName()

  return {
    ...describeIsolation(backend ?? 'process'),
    available: Boolean(backend),
  }
}

export { TERMINATION }
