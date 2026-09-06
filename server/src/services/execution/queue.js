import { randomUUID } from 'node:crypto'
import { AppError } from '../../errors.js'
import { isTerminal, TERMINATION } from './limits.js'

/**
 * The waiting room between "someone pressed Run" and "a process started".
 *
 * Before this there was one counter: four runs at a time, and the fifth was
 * refused outright. That is a fine answer to load and a poor answer to abuse,
 * because the four slots are first-come-first-served — one person with a
 * script can hold all of them continuously and everyone else in every room
 * gets `runner_busy` forever. A queue with per-user and per-room admission
 * turns that from a denial of service into a slower turn for the person doing
 * it.
 *
 * Built as a factory rather than a singleton so its tests can drive it with an
 * instant fake runner. Queue behaviour that can only be observed by starting
 * real compilers is queue behaviour nobody will test properly.
 */

export function createExecutionQueue({ run, caps, onState = () => {}, now = () => Date.now() }) {
  /** Everything not yet finished, oldest first. */
  const pending = []
  /** Every job by id, including finished ones until the caller forgets them. */
  const jobs = new Map()

  let active = 0

  const inFlight = (predicate) =>
    [...jobs.values()].filter((job) => !isTerminal(job.state) && predicate(job)).length

  const setState = (job, state, extra = {}) => {
    job.state = state
    Object.assign(job, extra)
    onState(job)
  }

  function admit({ userKey, roomId }) {
    const limits = caps()

    if (inFlight((job) => job.userKey === userKey) >= limits.perUser) {
      throw new AppError(
        429,
        'You already have ' + limits.perUser + ' programs queued or running. Wait for one to finish.',
        'user_execution_limit'
      )
    }

    if (inFlight((job) => job.roomId === roomId) >= limits.perRoom) {
      throw new AppError(
        429,
        'This room already has ' + limits.perRoom + ' programs queued or running.',
        'room_execution_limit'
      )
    }

    if (pending.length >= limits.queueDepth) {
      throw new AppError(
        429,
        'Too many programs are waiting to run right now, try again in a moment',
        'runner_busy'
      )
    }
  }

  function pump() {
    const limits = caps()

    while (active < limits.concurrent && pending.length > 0) {
      const job = pending.shift()

      // Cancelled while it waited: it never becomes a process.
      if (job.state === 'cancelled') continue

      active += 1
      start(job)
    }
  }

  async function start(job) {
    job.startedAt = now()
    setState(job, 'running')

    try {
      const result = await run(job, job.controller.signal)
      finish(job, result)
    } catch (error) {
      // A backend that threw rather than returning a result: a missing
      // toolchain, an unwritable directory, a daemon that went away.
      finish(job, null, error)
    } finally {
      active -= 1
      pump()
    }
  }

  /**
   * Turns what the backend reported into one of the seven states.
   *
   * The order matters. A cancelled run may also have timed out on its way
   * down, and an out-of-memory kill arrives looking exactly like a program
   * that exited non-zero — asking the questions in the wrong order gives an
   * answer that is true but useless.
   */
  function classify(result) {
    if (!result) return { state: 'failed', termination: TERMINATION.INTERNAL }
    if (result.cancelled) return { state: 'cancelled', termination: TERMINATION.CANCELLED }
    if (result.timedOut) return { state: 'timed_out', termination: TERMINATION.TIMEOUT }

    if (result.oomKilled) return { state: 'resource_limit', termination: TERMINATION.MEMORY }
    if (result.truncated) return { state: 'resource_limit', termination: TERMINATION.OUTPUT }
    if (result.termination === TERMINATION.PROCESSES) {
      return { state: 'resource_limit', termination: TERMINATION.PROCESSES }
    }

    if (result.failedToStart) return { state: 'failed', termination: TERMINATION.STARTUP }
    if (result.exitCode === 0) return { state: 'completed', termination: TERMINATION.EXITED }

    return { state: 'failed', termination: TERMINATION.EXITED }
  }

  function finish(job, result, error) {
    if (isTerminal(job.state) && job.state !== 'cancelled') return

    const { state, termination } = job.state === 'cancelled'
      ? { state: 'cancelled', termination: TERMINATION.CANCELLED }
      : classify(result)

    job.finishedAt = now()
    job.durationMs = job.startedAt ? job.finishedAt - job.startedAt : 0
    job.result = result ?? null
    job.error = error ?? null

    setState(job, state, { termination })
    job.settle(job)
  }

  return {
    /**
     * Accepts a run, or explains why not.
     *
     * Returns immediately with the job — the caller decides whether to wait on
     * `job.done`. That is what lets one HTTP request hold the connection open
     * for the answer while the room is told "queued" the moment it is queued.
     */
    submit({ roomId, userKey, user, language, sourceHash, payload }) {
      admit({ userKey, roomId })

      const job = {
        executionId: randomUUID(),
        roomId,
        userKey,
        user,
        language,
        sourceHash,
        payload,
        state: 'queued',
        termination: null,
        queuedAt: now(),
        startedAt: null,
        finishedAt: null,
        durationMs: 0,
        result: null,
        error: null,
        controller: new AbortController(),
      }

      job.done = new Promise((resolve) => {
        job.settle = resolve
      })

      jobs.set(job.executionId, job)
      pending.push(job)
      onState(job)
      pump()

      return job
    },

    /**
     * Stops a run, whether it has started or not.
     *
     * Returns false rather than throwing when there is nothing to stop: a
     * Cancel button pressed as the program exits is a race, not a mistake, and
     * an error toast for winning it would be nonsense.
     */
    cancel(executionId, { userKey } = {}) {
      const job = jobs.get(executionId)
      if (!job || isTerminal(job.state)) return false

      // Whoever started it, or a room owner acting through the route, which
      // does its own check before calling this.
      if (userKey && job.userKey !== userKey) return false

      const wasQueued = job.state === 'queued'
      setState(job, 'cancelled', { termination: TERMINATION.CANCELLED })
      job.controller.abort()

      if (wasQueued) {
        // Never started, so nothing will call finish() for it.
        job.finishedAt = now()
        job.settle(job)
      }

      return true
    },

    get: (executionId) => jobs.get(executionId) ?? null,

    /** What the queue currently looks like, for diagnostics and tests. */
    stats: () => ({
      active,
      queued: pending.length,
      known: jobs.size,
    }),

    /** Drops finished jobs; the durable record lives in MongoDB. */
    forget(executionId) {
      return jobs.delete(executionId)
    },

    /** Test seam: abandons everything without running it. */
    clear() {
      for (const job of jobs.values()) {
        if (!isTerminal(job.state)) {
          job.controller.abort()
          setState(job, 'cancelled', { termination: TERMINATION.CANCELLED })
          job.settle(job)
        }
      }
      pending.length = 0
      jobs.clear()
      active = 0
    },
  }
}
