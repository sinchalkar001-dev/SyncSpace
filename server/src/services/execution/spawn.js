import { spawn } from 'node:child_process'
import { logger } from '../../config/logger.js'
import { TERMINATION } from './limits.js'

/**
 * How long to wait for a killed process to actually report that it died.
 *
 * A run resolves when the child emits `close`, and nothing guarantees that
 * ever arrives: `taskkill` can fail, a grandchild can hold the pipes open, a
 * process can be unkillable in uninterruptible sleep. Without a backstop that
 * run stays `running` forever, holding a queue slot and a slice of its
 * author's allowance — so a program that resists being killed becomes a
 * permanent denial of service against the person who ran it, which is the
 * opposite of what a timeout is for.
 *
 * Two seconds is far longer than a SIGKILL needs and short enough that nobody
 * waits on it.
 */
const KILL_GRACE_MS = 2000

/**
 * Starting one process and collecting what it prints, within limits.
 *
 * Lifted out of the runner unchanged in behaviour so that both backends can
 * use it: the process backend runs a compiler or an interpreter with it, and
 * the Docker backend runs `docker` itself with it. Everything specific to
 * either lives in the backend; this only knows how to hold a child to a clock
 * and an output budget.
 */

export const isWindows = process.platform === 'win32'

/**
 * Kills the process and everything it started.
 *
 * `child.kill()` alone signals one process. A program that spawned children —
 * `go run` compiles and then executes, a script may fork — would leave them
 * running after the timeout, holding the working directory open.
 */
export function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode) return

  if (isWindows) {
    // Best effort: the child may have exited between the check and here, and
    // taskkill's complaint about a missing pid is not interesting.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    killer.on('error', () => {})
    return
  }

  try {
    // A negative pid signals the whole process group, which `detached` created.
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/**
 * Runs a command and resolves with how it went.
 *
 * Never rejects: a program that fails to start, times out, is cancelled or
 * dies on a signal is a result to show someone, not an error to handle. The
 * one thing a caller must do with the result is look at `termination`.
 *
 * @param {object} options
 * @param {string} options.cwd            working directory for the child
 * @param {string} [options.stdin]        fed to the program, then closed
 * @param {number} options.timeoutMs      wall clock before the tree is killed
 * @param {number} options.outputLimit    bytes of stdout+stderr kept
 * @param {object} [options.env]          the child's entire environment
 * @param {AbortSignal} [options.signal]  cancels the run
 * @param {(text: string) => string} [options.redact] applied to both streams
 * @param {(child: object) => void} [options.onSpawn] handed the live child
 */
export function spawnCollect(command, args, options) {
  const {
    cwd,
    stdin = '',
    timeoutMs,
    outputLimit,
    env: childEnvironment,
    signal,
    redact = (text) => text,
    onSpawn,
  } = options

  return new Promise((resolve) => {
    const started = Date.now()

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let cancelled = false
    let settled = false

    const child = spawn(command, args, {
      cwd,
      env: childEnvironment,
      windowsHide: true,
      // A process group, so the whole tree can be signalled at once.
      detached: !isWindows,
    })

    onSpawn?.(child)

    let graceTimer = null

    /**
     * Kills the tree, and makes sure this settles whether that worked or not.
     *
     * Every path that ends a run early goes through here — the timeout, a
     * cancellation, and the output cap — because every one of them has the
     * same problem: `killTree` is a request, and `close` is the only thing
     * that resolves the promise.
     */
    const endEarly = () => {
      // Stop listening before anything else.
      //
      // A program printing as fast as it can delivers data events faster than
      // this process can do anything else, and Node runs timers *after* the
      // poll phase — so the kill lands, the program keeps writing, and the
      // grace timer below never gets a turn. The run hangs for minutes on a
      // deadline that already passed. Reading output we have decided to throw
      // away is pure cost in every sense: it burns the server's event loop to
      // fill a buffer nobody will read.
      child.stdout.removeAllListeners('data')
      child.stderr.removeAllListeners('data')
      child.stdout.destroy()
      child.stderr.destroy()

      killTree(child)
      if (graceTimer) return

      graceTimer = setTimeout(() => {
        logger.warn(
          { pid: child.pid, command },
          'a killed program did not report that it exited; abandoning it to free the slot'
        )
        // One more try on the way out. If it is still there afterwards it is
        // a leaked process, which is bad — but a leaked process plus a leaked
        // queue slot is worse, and only one of the two is fixable here.
        killTree(child)
        finish({ exitCode: null, signal: 'SIGKILL', abandoned: true })
      }, KILL_GRACE_MS)
      // Nothing should be kept alive purely to wait for this.
      graceTimer.unref?.()
    }

    const onAbort = () => {
      cancelled = true
      endEarly()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      signal?.removeEventListener('abort', onAbort)

      const termination = cancelled
        ? TERMINATION.CANCELLED
        : timedOut
          ? TERMINATION.TIMEOUT
          : truncated
            ? TERMINATION.OUTPUT
            : extra.failedToStart
              ? TERMINATION.STARTUP
              : TERMINATION.EXITED

      resolve({
        // Redacted here rather than at the edge, so there is one place where
        // output stops being the host's and becomes the room's.
        stdout: redact(stdout),
        stderr: redact(stderr),
        truncated,
        timedOut,
        cancelled,
        termination,
        durationMs: Date.now() - started,
        ...extra,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      endEarly()
    }, timeoutMs)

    const collect = (which) => (chunk) => {
      const room = outputLimit - (stdout.length + stderr.length)

      if (room <= 0) {
        truncated = true
        // Stopping the program rather than only dropping the text. A loop
        // printing forever is cheap to ignore and expensive to host: it keeps
        // a slot, a process and a core busy for the whole timeout while
        // producing nothing anybody will ever read. The cap is a limit on the
        // run, not merely on the transcript.
        endEarly()
        return
      }

      const text = chunk.length > room ? chunk.slice(0, room) : chunk
      if (text.length < chunk.length) truncated = true
      if (which === 'out') stdout += text
      else stderr += text
    }

    // Encoding on the stream, not per chunk: a character split across two
    // buffers would otherwise decode as garbage.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', collect('out'))
    child.stderr.on('data', collect('err'))

    // A program that never reads its input closes the pipe under us.
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)

    child.on('error', (error) => {
      finish({
        exitCode: null,
        signal: null,
        failedToStart: error.code === 'ENOENT',
        message: error.message,
      })
    })

    child.on('close', (code, signalName) => finish({ exitCode: code, signal: signalName }))
  })
}
