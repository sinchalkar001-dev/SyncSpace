import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppError, badRequest, forbidden } from '../errors.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

/**
 * Runs a room's buffer and returns what it printed.
 *
 * This executes real programs on the machine hosting the server. There is no
 * container and no syscall filter here, so the protections are the ones a
 * single process can enforce: a throwaway working directory, a scrubbed
 * environment, a wall-clock limit, an output cap, and a ceiling on how many
 * runs happen at once. Access control is the route's job — only someone who
 * can open the room can run its code.
 *
 * The environment matters more than it looks. A child would otherwise inherit
 * MONGODB_URI and JWT_SECRET, which would hand every secret this server holds
 * to whatever someone pasted into the editor.
 */

const isWindows = process.platform === 'win32'
const PYTHON = isWindows ? 'python' : 'python3'
const BINARY = isWindows ? 'program.exe' : 'program'

/**
 * How each language becomes a process. `run` and `compile` take the working
 * directory because a compiled binary is invoked by absolute path; `probe`
 * asks the toolchain for its version, which is how availability is decided.
 */
export const RECIPES = {
  javascript: {
    file: 'main.js',
    run: () => ['node', ['main.js']],
    probe: ['node', ['--version']],
    toolchain: 'Node.js',
  },
  typescript: {
    file: 'main.ts',
    // Node strips the types and runs the JavaScript underneath; no tsc, and
    // so no type checking either.
    run: () => ['node', ['--experimental-strip-types', 'main.ts']],
    // Probing the flag rather than node itself: type stripping only exists
    // from Node 22.6, and an older runtime would otherwise advertise every
    // .ts buffer as runnable, then die on a confusing "bad option".
    probe: ['node', ['--experimental-strip-types', '-e', '']],
    toolchain: 'Node.js',
  },
  python: {
    file: 'main.py',
    // -u keeps output unbuffered, so a program killed on the timeout still
    // shows everything it had already printed.
    run: () => [PYTHON, ['-u', 'main.py']],
    probe: [PYTHON, ['--version']],
    toolchain: 'Python 3',
  },
  java: {
    file: 'Main.java',
    // Single-file source mode (JEP 330): compiled in memory, no javac step.
    run: () => ['java', ['Main.java']],
    probe: ['java', ['-version']],
    toolchain: 'JDK 11+',
  },
  cpp: {
    file: 'main.cpp',
    compile: () => ['g++', ['-std=c++17', 'main.cpp', '-o', BINARY]],
    run: (dir) => [path.join(dir, BINARY), []],
    probe: ['g++', ['--version']],
    toolchain: 'g++',
  },
  go: {
    file: 'main.go',
    run: () => ['go', ['run', 'main.go']],
    probe: ['go', ['version']],
    toolchain: 'Go',
  },
  rust: {
    file: 'main.rs',
    compile: () => ['rustc', ['main.rs', '-o', BINARY]],
    run: (dir) => [path.join(dir, BINARY), []],
    probe: ['rustc', ['--version']],
    toolchain: 'Rust',
  },
}

export const RUNNABLE_LANGUAGES = Object.keys(RECIPES)

/**
 * The only variables a child is allowed to see. Toolchains genuinely need
 * these — Go will not build without a cache directory, Java wants its home —
 * and everything else the server holds stays behind.
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
  : ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'JAVA_HOME', 'GOPATH', 'GOROOT', 'GOCACHE', 'CARGO_HOME', 'RUSTUP_HOME']

function childEnv() {
  const picked = {}
  for (const key of PASSTHROUGH) {
    if (process.env[key] !== undefined) picked[key] = process.env[key]
  }
  return picked
}

/**
 * Kills the process and everything it started.
 *
 * `child.kill()` alone signals one process. A program that spawned children —
 * `go run` compiles and then executes, a script may fork — would leave them
 * running after the timeout, holding the temp directory open.
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode) return

  if (isWindows) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    return
  }

  try {
    // Negative pid signals the whole process group, which `detached` created.
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/**
 * Spawns one process and collects what it prints, within limits.
 *
 * Never rejects: a program that fails to start, times out or dies on a signal
 * is a result to show someone, not an error to handle.
 */
function spawnCollect(command, args, { cwd, stdin = '', timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const limit = env.RUN_OUTPUT_LIMIT

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false

    const child = spawn(command, args, {
      cwd,
      env: childEnv(),
      windowsHide: true,
      // A process group so the whole tree can be signalled at once.
      detached: !isWindows,
    })

    const finish = (extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout,
        stderr,
        truncated,
        timedOut,
        durationMs: Date.now() - started,
        ...extra,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)

    const collect = (which) => (chunk) => {
      const current = which === 'out' ? stdout : stderr
      const room = limit - (stdout.length + stderr.length)
      if (room <= 0) {
        truncated = true
        return
      }
      const text = chunk.length > room ? chunk.slice(0, room) : chunk
      if (text.length < chunk.length) truncated = true
      if (which === 'out') stdout = current + text
      else stderr = current + text
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

    child.on('close', (code, signal) => finish({ exitCode: code, signal }))
  })
}

const missingToolchain = (language) =>
  new AppError(
    501,
    (RECIPES[language]?.toolchain || language) +
      ' is not installed on the server, so ' +
      language +
      ' cannot run here',
    'toolchain_missing'
  )

let active = 0

/**
 * Compiles if the language needs it, then runs, and always removes the
 * directory it worked in.
 */
export async function runCode({ language, code, stdin = '' }) {
  if (!env.ALLOW_CODE_EXECUTION) {
    throw forbidden('Running code is switched off on this server', 'execution_disabled')
  }

  const recipe = RECIPES[language]
  if (!recipe) {
    throw badRequest(
      language + ' has no runner here — it can be edited and shared, but not run',
      'language_not_runnable'
    )
  }

  if (active >= env.RUN_MAX_CONCURRENT) {
    throw new AppError(
      429,
      'Too many programs are running right now, try again in a moment',
      'runner_busy'
    )
  }

  active += 1
  try {
    return await execute(recipe, { language, code, stdin })
  } finally {
    // Released here rather than beside the working directory: a temp directory
    // that could not be created would otherwise hold its slot forever, and
    // enough of those would refuse every run from then on.
    active -= 1
  }
}

async function execute(recipe, { language, code, stdin }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'syncspace-run-'))

  try {
    await writeFile(path.join(dir, recipe.file), code, 'utf8')

    if (recipe.compile) {
      const [command, args] = recipe.compile(dir)
      // Compilers are slower than the programs they produce, and a build that
      // overran the run budget would look like a hanging program.
      const compiled = await spawnCollect(command, args, {
        cwd: dir,
        timeoutMs: env.RUN_TIMEOUT_MS * 2,
      })

      if (compiled.failedToStart) throw missingToolchain(language)
      if (compiled.exitCode !== 0 || compiled.timedOut) {
        return { language, stage: 'compile', ok: false, ...compiled }
      }
    }

    const [command, args] = recipe.run(dir)
    const result = await spawnCollect(command, args, {
      cwd: dir,
      stdin,
      timeoutMs: env.RUN_TIMEOUT_MS,
    })

    if (result.failedToStart) throw missingToolchain(language)

    return {
      language,
      stage: 'run',
      ok: result.exitCode === 0 && !result.timedOut,
      ...result,
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((error) => {
      logger.warn({ err: error, dir }, 'could not remove a run directory')
    })
  }
}

let availability = null

/**
 * Which languages this machine can actually run, by asking each toolchain for
 * its version. Probed once and remembered: installing a compiler while the
 * server is up is not a case worth re-checking on every request for.
 */
export function listRunnable() {
  if (availability) return availability

  availability = Promise.all(
    RUNNABLE_LANGUAGES.map(async (language) => {
      const [command, args] = RECIPES[language].probe
      const result = await spawnCollect(command, args, { cwd: os.tmpdir(), timeoutMs: 5000 })
      // Some toolchains report their version on stderr (java does).
      const output = (result.stdout + result.stderr).trim().split('\n')[0] || ''

      return {
        language,
        available: !result.failedToStart && result.exitCode === 0,
        toolchain: RECIPES[language].toolchain,
        version: output.slice(0, 80),
      }
    })
  ).catch((error) => {
    logger.warn({ err: error }, 'could not probe the installed toolchains')
    availability = null
    return []
  })

  return availability
}

/** Test seam: forces the next listRunnable() to probe again. */
export function resetRunnableCache() {
  availability = null
}
