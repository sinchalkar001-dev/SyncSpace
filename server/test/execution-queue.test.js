import { describe, expect, it, vi } from 'vitest'
import { createExecutionQueue } from '../src/services/execution/queue.js'
import { isTerminal, STATES, TERMINATION } from '../src/services/execution/limits.js'

/**
 * The queue on its own, driven by a runner that is not a process.
 *
 * Queue behaviour that can only be observed by starting real compilers is
 * queue behaviour nobody tests properly: every case takes seconds, the
 * interesting ones are races, and a flaky suite gets its assertions loosened
 * until it proves nothing. Here a "run" is a promise the test resolves when it
 * chooses, so ordering is exact and the whole file finishes in milliseconds.
 */

const CAPS = { concurrent: 2, perUser: 2, perRoom: 4, queueDepth: 10 }

/** A runner whose every job is held open until the test releases it. */
function controllable() {
  const held = new Map()

  const run = (job, signal) =>
    new Promise((resolve) => {
      held.set(job.executionId, resolve)
      signal.addEventListener('abort', () => resolve({ cancelled: true, exitCode: null }), {
        once: true,
      })
    })

  return {
    run,
    running: () => [...held.keys()],
    release: (executionId, result = { exitCode: 0, stdout: 'done' }) => {
      held.get(executionId)?.(result)
      held.delete(executionId)
    },
    releaseAll: (result = { exitCode: 0 }) => {
      for (const resolve of held.values()) resolve(result)
      held.clear()
    },
  }
}

const submit = (queue, extra = {}) =>
  queue.submit({
    roomId: 'room-1',
    userKey: 'user-1',
    user: { id: 'user-1', name: 'Ada' },
    language: 'javascript',
    sourceHash: 'abc',
    payload: { code: 'x' },
    ...extra,
  })

describe('what the queue promises', () => {
  it('starts a job immediately when there is room', async () => {
    const runner = controllable()
    const queue = createExecutionQueue({ run: runner.run, caps: () => CAPS })

    const job = submit(queue)
    await Promise.resolve()

    expect(job.state).toBe('running')
    expect(queue.stats().active).toBe(1)
  })

  it('holds a job back when every slot is busy, then starts it', async () => {
    const runner = controllable()
    const queue = createExecutionQueue({ run: runner.run, caps: () => ({ ...CAPS, concurrent: 1 }) })

    const first = submit(queue)
    const second = submit(queue)
    await Promise.resolve()

    expect(first.state).toBe('running')
    expect(second.state).toBe('queued')

    runner.release(first.executionId)
    await first.done

    expect(second.state).toBe('running')
  })

  it('gives every job an id of its own', () => {
    const runner = controllable()
    const queue = createExecutionQueue({ run: runner.run, caps: () => CAPS })

    const ids = new Set([submit(queue).executionId, submit(queue).executionId])
    expect(ids.size).toBe(2)
  })

  /** Both directions: the state a caller sees and the order they see it in. */
  it('announces every transition, in order, exactly once', async () => {
    const runner = controllable()
    const seen = []
    const queue = createExecutionQueue({
      run: runner.run,
      caps: () => CAPS,
      onState: (job) => seen.push(job.state),
    })

    const job = submit(queue)
    await Promise.resolve()
    runner.release(job.executionId)
    await job.done

    expect(seen).toEqual(['queued', 'running', 'completed'])
  })
})

describe('admission', () => {
  it('refuses one person more than their share, and says which limit', () => {
    const runner = controllable()
    const queue = createExecutionQueue({ run: runner.run, caps: () => ({ ...CAPS, perUser: 1 }) })

    submit(queue)
    expect(() => submit(queue)).toThrowError(
      expect.objectContaining({ status: 429, code: 'user_execution_limit' })
    )
  })

  it('counts a room across everybody in it', () => {
    const runner = controllable()
    const queue = createExecutionQueue({ run: runner.run, caps: () => ({ ...CAPS, perRoom: 1 }) })

    submit(queue, { userKey: 'user-1' })
    expect(() => submit(queue, { userKey: 'user-2' })).toThrowError(
      expect.objectContaining({ code: 'room_execution_limit' })
    )
  })

  it('lets somebody else in when the room limit is another room', () => {
    const runner = controllable()
    const queue = createExecutionQueue({ run: runner.run, caps: () => ({ ...CAPS, perRoom: 1 }) })

    submit(queue, { roomId: 'room-1' })
    expect(() => submit(queue, { roomId: 'room-2', userKey: 'user-2' })).not.toThrow()
  })

  /** A finished job must stop counting, or the limit becomes permanent. */
  it('frees a person’s allowance when their job finishes', async () => {
    const runner = controllable()
    const queue = createExecutionQueue({ run: runner.run, caps: () => ({ ...CAPS, perUser: 1 }) })

    const job = submit(queue)
    await Promise.resolve()
    runner.release(job.executionId)
    await job.done

    expect(() => submit(queue)).not.toThrow()
  })

  it('refuses when the queue itself is full', () => {
    const runner = controllable()
    const queue = createExecutionQueue({
      run: runner.run,
      caps: () => ({ concurrent: 1, perUser: 50, perRoom: 50, queueDepth: 2 }),
    })

    submit(queue)
    submit(queue)
    submit(queue)

    expect(() => submit(queue)).toThrowError(expect.objectContaining({ code: 'runner_busy' }))
  })
})

describe('cancellation', () => {
  it('stops a job that is running', async () => {
    const runner = controllable()
    const queue = createExecutionQueue({ run: runner.run, caps: () => CAPS })

    const job = submit(queue)
    await Promise.resolve()

    expect(queue.cancel(job.executionId, { userKey: 'user-1' })).toBe(true)
    await job.done

    expect(job.state).toBe('cancelled')
    expect(job.termination).toBe(TERMINATION.CANCELLED)
  })

  /** The one that never becomes a process at all. */
  it('stops a job that has not started, and it never runs', async () => {
    const runner = controllable()
    const run = vi.fn(runner.run)
    const queue = createExecutionQueue({ run, caps: () => ({ ...CAPS, concurrent: 1 }) })

    const first = submit(queue)
    const waiting = submit(queue)
    await Promise.resolve()

    expect(queue.cancel(waiting.executionId, { userKey: 'user-1' })).toBe(true)
    await waiting.done

    runner.release(first.executionId)
    await first.done

    expect(waiting.state).toBe('cancelled')
    // One call, for the job that was already running.
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('will not let one person cancel another person’s run', async () => {
    const runner = controllable()
    const queue = createExecutionQueue({ run: runner.run, caps: () => CAPS })

    const job = submit(queue, { userKey: 'user-1' })
    await Promise.resolve()

    expect(queue.cancel(job.executionId, { userKey: 'someone-else' })).toBe(false)
    expect(job.state).toBe('running')
  })

  it('says no rather than throwing when there is nothing left to cancel', async () => {
    const runner = controllable()
    const queue = createExecutionQueue({ run: runner.run, caps: () => CAPS })

    const job = submit(queue)
    await Promise.resolve()
    runner.release(job.executionId)
    await job.done

    // A Cancel pressed as the program exits is a race, not a mistake.
    expect(queue.cancel(job.executionId, { userKey: 'user-1' })).toBe(false)
    expect(queue.cancel('never-existed')).toBe(false)
  })

  it('gives the slot back so the next job starts', async () => {
    const runner = controllable()
    const queue = createExecutionQueue({ run: runner.run, caps: () => ({ ...CAPS, concurrent: 1 }) })

    const first = submit(queue)
    const second = submit(queue)
    await Promise.resolve()

    queue.cancel(first.executionId, { userKey: 'user-1' })
    await first.done

    expect(second.state).toBe('running')
  })
})

describe('turning a result into a state', () => {
  const finished = async (result) => {
    const queue = createExecutionQueue({ run: async () => result, caps: () => CAPS })
    const job = submit(queue)
    await job.done
    return job
  }

  it('calls a clean exit completed', async () => {
    expect((await finished({ exitCode: 0 })).state).toBe('completed')
  })

  it('calls a non-zero exit failed', async () => {
    const job = await finished({ exitCode: 1 })
    expect(job.state).toBe('failed')
    expect(job.termination).toBe(TERMINATION.EXITED)
  })

  it('calls a timeout timed out', async () => {
    expect((await finished({ timedOut: true, exitCode: null })).state).toBe('timed_out')
  })

  /**
   * An out-of-memory kill arrives looking exactly like a program that exited
   * non-zero, so it has to be asked about first or the answer is "failed" —
   * true, and no use to anybody.
   */
  it('calls an out-of-memory kill a resource limit, not a failure', async () => {
    const job = await finished({ oomKilled: true, exitCode: 137 })

    expect(job.state).toBe('resource_limit')
    expect(job.termination).toBe(TERMINATION.MEMORY)
  })

  it('calls a capped output a resource limit', async () => {
    const job = await finished({ truncated: true, exitCode: null })

    expect(job.state).toBe('resource_limit')
    expect(job.termination).toBe(TERMINATION.OUTPUT)
  })

  it('calls a backend that threw failed, without losing the reason', async () => {
    const queue = createExecutionQueue({
      run: async () => {
        throw new Error('the daemon went away')
      },
      caps: () => CAPS,
    })

    const job = submit(queue)
    await job.done

    expect(job.state).toBe('failed')
    expect(job.termination).toBe(TERMINATION.INTERNAL)
    expect(job.error.message).toBe('the daemon went away')
  })

  it('only ever reports a state it declared', async () => {
    const job = await finished({ exitCode: 0 })
    expect(STATES).toContain(job.state)
    expect(isTerminal(job.state)).toBe(true)
  })
})
