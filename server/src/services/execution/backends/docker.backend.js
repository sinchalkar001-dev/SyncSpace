import { env } from '../../../config/env.js'
import { logger } from '../../../config/logger.js'
import { containerContext } from '../recipes.js'
import { spawnCollect } from '../spawn.js'
import { TERMINATION } from '../limits.js'

/**
 * A container per run.
 *
 * Everything security-relevant about this system is the argument list built by
 * `buildRunArgs`, which is why that function is pure, exported, and tested
 * flag by flag rather than only through a container. A missing `--network
 * none` is not a behaviour anybody would notice in a passing end-to-end test:
 * the program would run, print its answer, and quietly have had a route to the
 * metadata endpoint the whole time.
 *
 * The container is deliberately not reused between runs. A fresh one costs
 * roughly 200ms against a 5s budget, and it is the only way "cleanup after
 * execution" means anything — no state, no files, no processes, and no
 * neighbour's leftovers survive to the next person who presses Run.
 */

const LABEL = 'syncspace.execution'
const MOUNT = '/work'

/**
 * Who the program runs as inside the container.
 *
 * Not root, ever. The default is the server's own uid where there is one,
 * because the working directory is bind-mounted from the host and a container
 * user that cannot write to it cannot compile anything. `nobody` is the
 * fallback on Windows, where Docker Desktop does not map POSIX ownership onto
 * the mount and the question does not arise.
 */
export function resolveUser() {
  if (env.SANDBOX_USER) return env.SANDBOX_USER

  if (typeof process.getuid === 'function') {
    const uid = process.getuid()
    const gid = typeof process.getgid === 'function' ? process.getgid() : uid
    // Running the server as root is its own problem, but it must not become
    // the container's problem too.
    if (uid > 0) return uid + ':' + gid
  }

  return '65534:65534'
}

/**
 * The whole of the isolation, as an argument list.
 *
 * Every flag here is load-bearing and none is decoration:
 *
 *   --network none          nothing this program does can reach the network,
 *                           including the cloud metadata endpoint that hands
 *                           out credentials on every major host
 *   --memory / --memory-swap  equal, so the limit cannot be escaped into swap
 *   --pids-limit            the answer to a fork bomb; without it a `:(){ :|:& };:`
 *                           takes the host down, not the container
 *   --read-only + --tmpfs   nothing outside the run's own directory is
 *                           writable, and /tmp is capped so filling it is
 *                           bounded
 *   --cap-drop ALL          no capabilities at all; nothing here needs one
 *   --security-opt no-new-privileges  a setuid binary inside the image cannot
 *                           be used to climb back out of the user below
 *   --user                  never root
 *   --ulimit fsize          a program cannot fill the bind mount either
 */
export function buildRunArgs({ executionId, image, workDir, limits, command, args, containerName }) {
  const memory = limits.memoryMb + 'm'

  const flags = [
    'run',
    '--name',
    containerName,
    '--label',
    LABEL + '=' + executionId,

    // Kept attached: stdout and stderr are the result, and stdin is the
    // program's input.
    '--interactive',

    // No network unless a deployment has deliberately turned it on.
    '--network',
    limits.network ? env.SANDBOX_NETWORK_NAME : 'none',

    '--memory',
    memory,
    // Equal to --memory: without this the container may swap instead of being
    // killed, which turns a memory limit into a machine-wide slowdown.
    '--memory-swap',
    memory,

    '--cpus',
    String(limits.cpus),
    '--pids-limit',
    String(limits.processes),

    '--read-only',
    '--tmpfs',
    // exec is needed: several toolchains stage executables through the cache.
    '/tmp:rw,exec,nosuid,nodev,size=' + limits.fileSizeMb + 'm',

    '--volume',
    workDir + ':' + MOUNT + ':rw',
    '--workdir',
    MOUNT,

    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    resolveUser(),

    // A program cannot fill the host disk through the bind mount.
    '--ulimit',
    'fsize=' + limits.fileSizeMb * 1024 * 1024,
    '--ulimit',
    'nofile=256:256',

    // Nothing from the server's environment reaches the container: Docker
    // passes none of it by default, and these are the only ones added back.
    '--env',
    'HOME=/tmp',
    '--env',
    'LANG=C.UTF-8',
    '--env',
    'GOCACHE=/tmp/go-build',
    '--env',
    'GOPATH=/tmp/go',
    '--env',
    'XDG_CACHE_HOME=/tmp',
    '--env',
    'CARGO_HOME=/tmp/cargo',
  ]

  if (env.SANDBOX_RUNTIME) flags.push('--runtime', env.SANDBOX_RUNTIME)

  return [...flags, image, command, ...args]
}

export const name = 'docker'

const docker = (args, options = {}) =>
  spawnCollect(env.SANDBOX_DOCKER_BIN, args, {
    cwd: process.cwd(),
    timeoutMs: options.timeoutMs ?? 15000,
    outputLimit: options.outputLimit ?? 8192,
    env: process.env,
    ...options,
  })

let cachedAvailability = null

/** Whether there is a working container runtime to talk to. */
export async function available() {
  if (cachedAvailability !== null) return cachedAvailability

  const result = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10000 })
  cachedAvailability = !result.failedToStart && result.exitCode === 0

  if (!cachedAvailability) {
    logger.warn(
      { stderr: result.stderr.slice(0, 200) },
      'no container runtime available for isolated execution'
    )
  }

  return cachedAvailability
}

export function resetAvailabilityCache() {
  cachedAvailability = null
}

const imageFor = (language, recipe) => env.SANDBOX_IMAGES?.[language] ?? recipe.image

/** Whether the image for a language is on this machine already. */
async function hasImage(image) {
  const result = await docker(['image', 'inspect', image, '--format', '{{.Id}}'])
  return result.exitCode === 0
}

/**
 * A language is runnable if its image is present, or if this deployment is
 * willing to pull it.
 *
 * Reported rather than pulled here: the first run of a language would
 * otherwise sit for a minute behind a download with no explanation, which
 * reads as a hang. `npm run sandbox:pull` fetches them ahead of time and the
 * README says to run it at deploy.
 */
export async function probe(recipe, { language } = {}) {
  const image = imageFor(language, recipe)

  if (!(await available())) return { available: false, version: '' }
  if (await hasImage(image)) return { available: true, version: image }

  return {
    available: Boolean(env.SANDBOX_PULL),
    version: image + (env.SANDBOX_PULL ? ' (will be pulled)' : ' (not pulled)'),
  }
}

/** Fetches every image this server might need. Used by the deploy script. */
export async function pullImages(languages) {
  const results = []
  for (const { language, recipe } of languages) {
    const image = imageFor(language, recipe)
    const result = await docker(['pull', image], { timeoutMs: 600000, outputLimit: 4096 })
    results.push({ language, image, ok: result.exitCode === 0, stderr: result.stderr })
  }
  return results
}

/**
 * Removes containers this server started and did not clean up.
 *
 * Every container is labelled and every run removes its own, so this normally
 * finds nothing. It finds something after a hard crash — and a stopped
 * container still holds its writable layer, so "normally nothing" left
 * unattended is still a disk that fills up over months.
 */
export async function reap() {
  if (!(await available())) return 0

  const listed = await docker(['ps', '--all', '--quiet', '--filter', 'label=' + LABEL])
  const ids = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  if (!ids.length) return 0

  await docker(['rm', '--force', ...ids], { timeoutMs: 30000 })
  logger.info({ count: ids.length }, 'removed orphaned execution containers')
  return ids.length
}

/** Best effort, and never the reason a run fails. */
async function remove(containerName) {
  const result = await docker(['rm', '--force', containerName], { timeoutMs: 20000 })
  if (result.exitCode !== 0 && !result.stderr.includes('No such container')) {
    logger.warn({ containerName, stderr: result.stderr.slice(0, 200) }, 'could not remove a container')
  }
}

/**
 * Why the container really stopped.
 *
 * The exit code alone cannot tell a memory kill from any other SIGKILL —
 * both arrive as 137, and one of those two answers is actionable while the
 * other is a shrug. This is the reason containers are not started with
 * `--rm`: the record has to outlive the process long enough to be read.
 */
async function inspect(containerName) {
  const result = await docker([
    'inspect',
    containerName,
    '--format',
    '{{.State.OOMKilled}} {{.State.ExitCode}}',
  ])

  if (result.exitCode !== 0) return { oomKilled: false, exitCode: null }

  const [oom, code] = result.stdout.trim().split(/\s+/)
  return { oomKilled: oom === 'true', exitCode: Number.parseInt(code, 10) }
}

async function runOnce({ executionId, image, workDir, limits, command, args, stdin, signal, redact, timeoutMs, phase }) {
  const containerName = 'syncspace-' + executionId.slice(0, 12) + '-' + phase

  try {
    const result = await spawnCollect(
      env.SANDBOX_DOCKER_BIN,
      buildRunArgs({ executionId, image, workDir, limits, command, args, containerName }),
      {
        cwd: workDir,
        stdin,
        timeoutMs,
        outputLimit: limits.outputBytes,
        // The docker client itself needs a real environment to find its
        // socket; the container gets none of it.
        env: process.env,
        signal,
        redact,
      }
    )

    if (result.failedToStart) return result

    // A memory kill and a timeout kill are indistinguishable by exit code, so
    // ask the daemon which it was before the record is thrown away.
    const state = await inspect(containerName)

    if (state.oomKilled) {
      return { ...result, exitCode: state.exitCode, oomKilled: true, termination: TERMINATION.MEMORY }
    }

    return { ...result, exitCode: result.exitCode === 0 ? 0 : (state.exitCode ?? result.exitCode) }
  } finally {
    // Not conditional on success: a timed-out `docker run` leaves the client
    // dead and the container very much alive.
    await remove(containerName)
  }
}

export async function execute({ recipe, language, workDir, stdin, limits, signal, redact, executionId }) {
  const image = imageFor(language, recipe)
  const context = containerContext(MOUNT)
  const shared = { executionId, image, workDir, limits, signal, redact }

  if (recipe.compile) {
    const [command, args] = recipe.compile(context)
    const compiled = await runOnce({
      ...shared,
      command,
      args,
      phase: 'build',
      timeoutMs: limits.compileTimeoutMs,
    })

    if (compiled.failedToStart) return { stage: 'compile', ...compiled }
    if (compiled.exitCode !== 0 || compiled.timedOut || compiled.cancelled) {
      return { stage: 'compile', ...compiled }
    }
  }

  const [command, args] = recipe.run(context)
  const result = await runOnce({
    ...shared,
    command,
    args,
    stdin,
    phase: 'run',
    timeoutMs: limits.timeoutMs,
  })

  return { stage: 'run', ...result }
}
