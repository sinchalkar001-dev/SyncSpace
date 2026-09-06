import { env } from '../../config/env.js'

/**
 * What a run is allowed to consume, and which of those limits the machine can
 * actually impose.
 *
 * The second half is the point. Every sandbox document ever written lists the
 * controls it *wants*; the interesting question is which ones are real on the
 * deployment in front of you. A server with no container runtime cannot cap
 * memory, cannot stop a program opening a socket, and cannot keep it out of
 * the filesystem — and saying otherwise in a README is how people end up
 * running a public room on a box they care about.
 *
 * So enforcement is data, not prose. The API reports it, the UI shows it, the
 * security tests assert against it, and the README table is generated from the
 * same source. A control that moves from "none" to "enforced" has to move here
 * first, where a test is watching.
 */

/** The lifecycle a job moves through, in the order it moves through it. */
export const STATES = Object.freeze([
  'queued',
  'running',
  'completed',
  'failed',
  'timed_out',
  'resource_limit',
  'cancelled',
])

/** States from which nothing further happens. */
export const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'timed_out', 'resource_limit', 'cancelled'])

export const isTerminal = (state) => TERMINAL_STATES.includes(state)

/**
 * Why a run ended, when it did not simply finish.
 *
 * Separate from the state because two runs can share a state for different
 * reasons — `resource_limit` covers both a memory ceiling and a process
 * ceiling, and telling someone which one they hit is the difference between a
 * fixable program and a mystery.
 */
export const TERMINATION = Object.freeze({
  EXITED: 'exited',
  TIMEOUT: 'timeout',
  MEMORY: 'memory_limit',
  OUTPUT: 'output_limit',
  PROCESSES: 'process_limit',
  CANCELLED: 'cancelled',
  STARTUP: 'failed_to_start',
  INTERNAL: 'internal_error',
})

/** Every resource control this system knows how to talk about. */
export const CONTROLS = Object.freeze([
  'timeout',
  'output',
  'memory',
  'cpu',
  'processes',
  'filesystem',
  'network',
  'environment',
  'cleanup',
])

/**
 * Which controls each backend really imposes.
 *
 * `process` is deliberately, visibly thin. It is the original runner: a
 * throwaway directory, a scrubbed environment, a wall clock and an output cap,
 * enforced by one Node process against a child that is a peer of the server on
 * the same machine. It cannot bound memory, it cannot stop a fork bomb, and a
 * program can read any file the server account can read and open any socket it
 * likes. Keeping it is not an endorsement — it is what makes this deployable
 * on a laptop without a container runtime, and what stops the feature
 * disappearing on a machine where Docker is not installed.
 */
export const ENFORCEMENT = Object.freeze({
  docker: Object.freeze({
    timeout: 'enforced',
    output: 'enforced',
    memory: 'enforced',
    cpu: 'enforced',
    processes: 'enforced',
    filesystem: 'enforced',
    network: 'enforced',
    environment: 'enforced',
    cleanup: 'enforced',
  }),
  process: Object.freeze({
    timeout: 'enforced',
    output: 'enforced',
    memory: 'none',
    cpu: 'none',
    processes: 'none',
    filesystem: 'none',
    network: 'none',
    environment: 'enforced',
    cleanup: 'enforced',
  }),
})

/** Human wording for each control, used by the API and the interface. */
export const CONTROL_LABELS = Object.freeze({
  timeout: 'Execution timeout',
  output: 'Maximum output size',
  memory: 'Memory limit',
  cpu: 'CPU limit',
  processes: 'Maximum process count',
  filesystem: 'Filesystem isolation',
  network: 'Network disabled',
  environment: 'Restricted environment variables',
  cleanup: 'Cleanup after execution',
})

/**
 * The numbers themselves, read fresh each time.
 *
 * Read rather than captured, because the tests move these at runtime — the
 * existing runner tests already do exactly that with the timeout and the
 * output cap, and a module-level snapshot would quietly ignore them.
 */
export function resolveLimits() {
  return {
    timeoutMs: env.RUN_TIMEOUT_MS,
    // Compilers are slower than the programs they produce, and a build that
    // overran the run budget would look to the author like a hanging program.
    compileTimeoutMs: env.RUN_TIMEOUT_MS * 2,
    outputBytes: env.RUN_OUTPUT_LIMIT,
    memoryMb: env.SANDBOX_MEMORY_MB,
    cpus: env.SANDBOX_CPUS,
    processes: env.SANDBOX_PIDS,
    fileSizeMb: env.SANDBOX_FILE_SIZE_MB,
    network: env.SANDBOX_NETWORK,
  }
}

/**
 * What a caller is told about the isolation in force.
 *
 * `weak` is the flag the interface keys off: not "is anything enforced" but
 * "is anything a hostile program cares about left unenforced".
 */
export function describeIsolation(backend) {
  const enforcement = ENFORCEMENT[backend] ?? ENFORCEMENT.process
  const limits = resolveLimits()

  return {
    backend,
    limits,
    enforcement,
    unenforced: CONTROLS.filter((control) => enforcement[control] === 'none'),
    weak: CONTROLS.some((control) => enforcement[control] === 'none'),
  }
}
