import os from 'node:os'
import { hostContext } from '../recipes.js'
import { isWindows, spawnCollect } from '../spawn.js'
import { TERMINATION } from '../limits.js'

/**
 * The original runner: a child process on the machine hosting the server.
 *
 * This is not a sandbox and is not described as one anywhere in this codebase.
 * It enforces a wall clock, an output cap, a throwaway working directory and a
 * scrubbed environment — the four things one Node process can impose on a
 * child that is otherwise its peer. A program running here can read any file
 * the server account can read, open any socket, allocate until the machine
 * swaps, and fork until the process table is full.
 *
 * It is kept for two reasons. It is the only thing that works on a machine
 * with no container runtime, which includes most laptops this is developed on;
 * and removing it would have meant the feature disappearing on those machines
 * the moment the sandbox landed, which is a worse outcome than an honest
 * warning. `ENFORCEMENT.process` in limits.js states exactly what it does not
 * do, the API reports it, and the interface says so next to the Run button.
 */

/**
 * The only variables a child is allowed to see.
 *
 * Toolchains genuinely need these — Go will not build without a cache
 * directory, Java wants its home — and everything else the server holds stays
 * behind. This matters more than it looks: a child would otherwise inherit
 * MONGODB_URI, JWT_SECRET and the mail relay password, handing every secret
 * this server has to whatever someone pasted into the editor.
 */
const PASSTHROUGH = isWindows
  ? [
      'PATH',
      'Path',
      'PATHEXT',
      'SystemRoot',
      'windir',
      'COMSPEC',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
      'APPDATA',
      'LOCALAPPDATA',
      'PROGRAMFILES',
      'PROGRAMFILES(X86)',
      'PROGRAMDATA',
      'NUMBER_OF_PROCESSORS',
      'OS',
      'JAVA_HOME',
      'GOPATH',
      'GOROOT',
      'GOCACHE',
      'CARGO_HOME',
      'RUSTUP_HOME',
    ]
  : [
      'PATH',
      'HOME',
      'LANG',
      'LC_ALL',
      'TMPDIR',
      'JAVA_HOME',
      'GOPATH',
      'GOROOT',
      'GOCACHE',
      'CARGO_HOME',
      'RUSTUP_HOME',
    ]

export function childEnv() {
  const picked = {}
  for (const key of PASSTHROUGH) {
    if (process.env[key] !== undefined) picked[key] = process.env[key]
  }
  return picked
}

export const name = 'process'

/** Always: this is the backend that needs nothing installed beyond a toolchain. */
export const available = async () => true

/** Nothing to reclaim — the orchestrator owns the working directory. */
export const reap = async () => 0

export async function probe(recipe, { timeoutMs = 5000 } = {}) {
  const [command, args] = recipe.probe
  const result = await spawnCollect(command, args, {
    cwd: os.tmpdir(),
    timeoutMs,
    outputLimit: 4096,
    env: childEnv(),
  })

  // Some toolchains report their version on stderr (java does).
  const output = (result.stdout + result.stderr).trim().split('\n')[0] || ''

  return {
    available: !result.failedToStart && result.exitCode === 0,
    version: output.slice(0, 80),
  }
}

/**
 * Compiles if the language needs it, then runs.
 *
 * The working directory is created and removed by the caller, so a failure
 * anywhere in here still leaves nothing behind.
 */
export async function execute({ recipe, workDir, stdin, limits, signal, redact }) {
  const context = hostContext(workDir)
  const shared = { cwd: workDir, outputLimit: limits.outputBytes, env: childEnv(), signal, redact }

  if (recipe.compile) {
    const [command, args] = recipe.compile(context)
    const compiled = await spawnCollect(command, args, {
      ...shared,
      timeoutMs: limits.compileTimeoutMs,
    })

    if (compiled.failedToStart) return { stage: 'compile', ...compiled }
    if (compiled.exitCode !== 0 || compiled.timedOut || compiled.cancelled) {
      return { stage: 'compile', ...compiled }
    }
  }

  const [command, args] = recipe.run(context)
  const result = await spawnCollect(command, args, { ...shared, stdin, timeoutMs: limits.timeoutMs })

  return { stage: 'run', ...result }
}

/** What this backend cannot promise, in the words the API uses. */
export const startupError = () => null

export { TERMINATION }
