import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../src/config/env.js'
import { runCode } from '../src/services/runner.service.js'
import { isolationStatus } from '../src/services/execution.service.js'
import { CONTROLS } from '../src/services/execution/limits.js'

/**
 * What a hostile program can and cannot do here.
 *
 * The hard part of a file like this is not writing the malicious programs. It
 * is that the answers depend on how the server is deployed: with a container
 * runtime a program cannot open a socket, and without one it certainly can.
 * A suite that asserted "the network is blocked" would pass on a laptop for
 * the wrong reason — nothing was listening — and would then keep passing after
 * somebody deleted the flag that blocks it.
 *
 * So every test below asks the server what it claims to enforce, and then
 * holds it to exactly that claim:
 *
 *   enforced  →  prove it empirically, with a program that tries
 *   none      →  prove the server admits it, out loud, in the API
 *
 * The result is a suite that is meaningful on both, and that cannot be made
 * to pass by weakening the sandbox — weakening it moves a control to "none",
 * and then the API has to say so where the interface and the README will
 * repeat it.
 */

let isolation
let enforced

beforeAll(async () => {
  isolation = await isolationStatus()
  enforced = (control) => isolation.enforcement[control] === 'enforced'
})

const original = {
  timeout: env.RUN_TIMEOUT_MS,
  limit: env.RUN_OUTPUT_LIMIT,
  perUser: env.SANDBOX_MAX_PER_USER,
}

afterEach(() => {
  env.RUN_TIMEOUT_MS = original.timeout
  env.RUN_OUTPUT_LIMIT = original.limit
  env.SANDBOX_MAX_PER_USER = original.perUser
})

const run = (code, extra = {}) => runCode({ language: 'javascript', code, ...extra })

describe('the enforcement claim itself', () => {
  it('answers for every control it knows about, with no gaps', () => {
    for (const control of CONTROLS) {
      expect(['enforced', 'none'], control).toContain(isolation.enforcement[control])
    }
  })

  /**
   * The property that keeps the rest of this file honest: a deployment that
   * cannot contain a program has to say so, and the interface reads this
   * rather than assuming.
   */
  it('admits in one word whether anything is left unenforced', () => {
    const gaps = CONTROLS.filter((control) => isolation.enforcement[control] === 'none')

    expect(isolation.weak).toBe(gaps.length > 0)
    expect(isolation.unenforced.sort()).toEqual(gaps.sort())
  })

  it('names the backend that actually ran, not the one that was configured', () => {
    expect(['docker', 'process']).toContain(isolation.backend)
  })
})

describe('a program that will not stop', () => {
  it('is killed on the timeout and reported as timed out', async () => {
    env.RUN_TIMEOUT_MS = 800

    const result = await run('while (true) {}')

    expect(result.state).toBe('timed_out')
    expect(result.termination).toBe('timeout')
    expect(result.timedOut).toBe(true)
    // The kill has to be why it ended, rather than the program relenting.
    expect(result.durationMs).toBeLessThan(6000)
  })

  /** A tight loop that also prints: neither limit may rescue the other. */
  it('is stopped even while it is producing output', async () => {
    env.RUN_TIMEOUT_MS = 800
    env.RUN_OUTPUT_LIMIT = 5_000_000

    const result = await run('while (true) { process.stdout.write("still here ") }')

    expect(['timed_out', 'resource_limit']).toContain(result.state)
    expect(result.durationMs).toBeLessThan(6000)
  })
})

describe('a program that asks for all the memory', () => {
  const HUNGRY =
    'const held = []\n' +
    'for (let i = 0; i < 400; i += 1) held.push(Buffer.alloc(1024 * 1024, 1))\n' +
    'console.log("allocated " + held.length)'

  it('is stopped by the memory limit, or the limit is declared absent', async () => {
    env.RUN_TIMEOUT_MS = 20000

    const result = await run(HUNGRY)

    if (enforced('memory')) {
      expect(result.state).toBe('resource_limit')
      expect(result.termination).toBe('memory_limit')
      expect(result.stdout).not.toContain('allocated')
      return
    }

    // No container: 400MB is simply allocated. The point of asserting it is
    // that this backend must not be described as capping memory anywhere.
    expect(isolation.unenforced).toContain('memory')
    expect(isolation.weak).toBe(true)
  }, 40000)
})

describe('a program that goes looking at the filesystem', () => {
  let sentinelDir
  let sentinel

  beforeAll(() => {
    // A file outside the run's own directory, in a place the server account
    // can plainly read. Reading *this* is the difference between a contained
    // program and a program on your machine.
    sentinelDir = mkdtempSync(path.join(os.tmpdir(), 'syncspace-sentinel-'))
    sentinel = path.join(sentinelDir, 'secret.txt')
    writeFileSync(sentinel, 'the-sentinel-value', 'utf8')
  })

  afterAll(() => rmSync(sentinelDir, { recursive: true, force: true }))

  it('cannot read a file outside its own directory, or the gap is declared', async () => {
    env.RUN_TIMEOUT_MS = 10000

    const code =
      'try {\n' +
      '  console.log(require("fs").readFileSync(' +
      JSON.stringify(sentinel) +
      ', "utf8"))\n' +
      '} catch (error) { console.log("refused: " + error.code) }'

    const result = await run(code)

    if (enforced('filesystem')) {
      expect(result.stdout).not.toContain('the-sentinel-value')
      expect(result.stdout).toContain('refused')
      return
    }

    // Unsandboxed, the program reads it — which is exactly the claim the
    // process backend makes about itself, and why it is not for public rooms.
    expect(result.stdout).toContain('the-sentinel-value')
    expect(isolation.unenforced).toContain('filesystem')
  }, 30000)

  /**
   * Whatever the backend, a run may not write where the next run will look.
   * This one holds on both, because the throwaway directory is the runner's
   * own doing rather than the container's.
   */
  it('never shares a working directory between runs', async () => {
    const wrote = await run('require("fs").writeFileSync("left-behind.txt", "x"); console.log("wrote")')
    const looked = await run('console.log(require("fs").existsSync("left-behind.txt") ? "found" : "clean")')

    expect(wrote.stdout.trim()).toBe('wrote')
    expect(looked.stdout.trim()).toBe('clean')
  })
})

describe('a program that reaches for the network', () => {
  let server
  let port

  beforeAll(async () => {
    // Something real to connect to, on this machine. Testing against the
    // internet would make "blocked" and "offline" the same result.
    server = net.createServer((socket) => {
      // The program calls process.exit the moment it has read the greeting,
      // which resets the connection under us. Unhandled, that ECONNRESET
      // reaches the process as an uncaught exception and fails the entire
      // suite from a test that has already passed.
      socket.on('error', () => {})
      socket.end('hello from the host\n')
    })
    server.on('error', () => {})
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  })

  afterAll(() => new Promise((resolve) => server.close(resolve)))

  it('cannot open a socket, or the gap is declared', async () => {
    env.RUN_TIMEOUT_MS = 10000

    const code =
      'const net = require("net")\n' +
      'const socket = net.connect(' +
      port +
      ', "127.0.0.1")\n' +
      'socket.on("data", (chunk) => { console.log("reached: " + chunk.toString().trim()); process.exit(0) })\n' +
      'socket.on("error", (error) => { console.log("refused: " + error.code); process.exit(0) })\n' +
      'setTimeout(() => { console.log("refused: timeout"); process.exit(0) }, 2000)'

    const result = await run(code)

    if (enforced('network')) {
      expect(result.stdout).toContain('refused')
      expect(result.stdout).not.toContain('reached')
      return
    }

    // The host's own loopback is reachable from an unsandboxed run, which is
    // the same reach it has to every internal service the server can see.
    expect(result.stdout).toContain('reached: hello from the host')
    expect(isolation.unenforced).toContain('network')
  }, 30000)
})

describe('a program that multiplies', () => {
  /**
   * Bounded on purpose: a real fork bomb is trivial to write and would take
   * this machine down rather than the test. Eighty children is well past a
   * sane process limit and well short of a denial of service.
   */
  const SPAWNER =
    'const { spawn } = require("child_process")\n' +
    'let started = 0\n' +
    'let refused = 0\n' +
    'for (let i = 0; i < 80; i += 1) {\n' +
    '  try {\n' +
    '    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"])\n' +
    '    child.on("error", () => { refused += 1 })\n' +
    '    started += 1\n' +
    '  } catch { refused += 1 }\n' +
    '}\n' +
    'setTimeout(() => console.log(JSON.stringify({ started, refused })), 800)'

  it('runs into the process limit, or the gap is declared', async () => {
    if (!enforced('processes')) {
      // Not run empirically on the process backend: eighty node processes on
      // a developer's machine is a cost with nothing to show for it, since
      // the answer is known and declared.
      expect(isolation.unenforced).toContain('processes')
      return
    }

    env.RUN_TIMEOUT_MS = 20000
    const result = await run(SPAWNER)

    // Either the container refused the forks, or it was killed for trying.
    if (result.state === 'completed') {
      const counts = JSON.parse(result.stdout.trim())
      expect(counts.refused).toBeGreaterThan(0)
    } else {
      expect(['resource_limit', 'failed', 'timed_out']).toContain(result.state)
    }
  }, 40000)
})

describe('a program that prints without stopping', () => {
  it('is capped and killed rather than merely truncated', async () => {
    env.RUN_OUTPUT_LIMIT = 4000
    env.RUN_TIMEOUT_MS = 10000

    const result = await run('while (true) { console.log("x".repeat(200)) }')

    expect(result.truncated).toBe(true)
    expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(4000)

    // The distinction that matters: the program was stopped, not left to burn
    // a core for the whole timeout while its output went in the bin.
    expect(result.state).toBe('resource_limit')
    expect(result.termination).toBe('output_limit')
    expect(result.durationMs).toBeLessThan(9000)
  }, 30000)
})

describe('what a program is told about the host', () => {
  /**
   * The leak this was written for: an uncaught error names the file it was
   * running by its real path, which spells out the operating system, the
   * account the server runs as, and where its temporary files live — to
   * everyone in the room, including a public one.
   */
  it('reports an error without naming the machine it happened on', async () => {
    const result = await run('throw new Error("boom")')

    expect(result.stderr).toContain('boom')

    // The directory this run got is the disclosure that matters, and it is
    // named after the product on every platform.
    expect(result.stderr).not.toContain('syncspace-run-')
    expect(result.stderr).not.toContain(os.homedir())

    // Only where the temp directory is somewhere private. On Linux it is
    // already `/tmp`, which is both the real location and the stand-in, so
    // there is nothing here to be absent.
    if (os.tmpdir() !== '/tmp') expect(result.stderr).not.toContain(os.tmpdir())

    const account = process.env.USERNAME || process.env.USER
    if (account) expect(result.stderr).not.toContain(account)
  })

  it('hands over none of the server credentials', async () => {
    process.env.MONGODB_URI = 'mongodb://someone:hunter2@localhost:27017/syncspace'
    process.env.JWT_SECRET = 'a-very-secret-signing-key'
    process.env.SMTP_PASS = 'an-app-password'

    const result = await run('console.log(JSON.stringify(process.env))')

    expect(result.stdout).not.toContain('hunter2')
    expect(result.stdout).not.toContain('a-very-secret-signing-key')
    expect(result.stdout).not.toContain('an-app-password')
  })
})
