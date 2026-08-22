import { afterEach, describe, expect, it } from 'vitest'
import { env } from '../src/config/env.js'
import { listRunnable, runCode } from '../src/services/runner.service.js'

const original = {
  timeout: env.RUN_TIMEOUT_MS,
  limit: env.RUN_OUTPUT_LIMIT,
  enabled: env.ALLOW_CODE_EXECUTION,
  concurrent: env.RUN_MAX_CONCURRENT,
}

afterEach(() => {
  env.RUN_TIMEOUT_MS = original.timeout
  env.RUN_OUTPUT_LIMIT = original.limit
  env.ALLOW_CODE_EXECUTION = original.enabled
  env.RUN_MAX_CONCURRENT = original.concurrent
})

const run = (code, extra = {}) => runCode({ language: 'javascript', code, ...extra })

describe('running code', () => {
  it('returns what the program printed and the code it exited with', async () => {
    const result = await run('console.log("hello"); console.error("a warning")')

    expect(result.stdout).toBe('hello\n')
    expect(result.stderr).toBe('a warning\n')
    expect(result.exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('run')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports a failure as a result rather than an error', async () => {
    const result = await run('throw new Error("boom")')

    expect(result.ok).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('boom')
  })

  it('feeds stdin to the program', async () => {
    const code = [
      'let input = ""',
      'process.stdin.on("data", (chunk) => { input += chunk })',
      'process.stdin.on("end", () => console.log("got: " + input.trim()))',
    ].join('\n')

    const result = await run(code, { stdin: 'a line of input' })
    expect(result.stdout).toBe('got: a line of input\n')
  })

  it('stops a program that will not finish, keeping what it printed first', async () => {
    env.RUN_TIMEOUT_MS = 700

    const result = await run('console.log("before"); while (true) {}')

    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.stdout).toContain('before')
    // Well under the wall clock: the kill has to be the reason it ended.
    expect(result.durationMs).toBeLessThan(6000)
  })

  it('caps runaway output instead of buffering all of it', async () => {
    env.RUN_OUTPUT_LIMIT = 2000

    const result = await run('for (let i = 0; i < 100000; i += 1) console.log("x".repeat(80))')

    expect(result.truncated).toBe(true)
    expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(2000)
  })

  /**
   * The one that matters most. A child inherits the parent's environment by
   * default, which here would hand the database URI and the token signing key
   * to whatever someone pasted into the editor.
   */
  it('does not let a program read the server secrets', async () => {
    process.env.MONGODB_URI = 'mongodb://someone:hunter2@localhost:27017/syncspace'
    process.env.JWT_SECRET = 'a-very-secret-signing-key'

    const result = await run('console.log(JSON.stringify(process.env))')
    const seen = JSON.parse(result.stdout)

    expect(seen.MONGODB_URI).toBeUndefined()
    expect(seen.JWT_SECRET).toBeUndefined()
    expect(result.stdout).not.toContain('hunter2')
    // PATH still has to be there, or nothing would run at all.
    expect(seen.PATH || seen.Path).toBeTruthy()
  })

  it('runs each program somewhere of its own', async () => {
    const code = 'console.log(process.cwd())'
    const [first, second] = await Promise.all([run(code), run(code)])

    expect(first.stdout.trim()).not.toBe(second.stdout.trim())
    expect(first.stdout).toContain('syncspace-run-')
  })

  it('refuses a language it has no runner for', async () => {
    await expect(runCode({ language: 'markdown', code: '# hi' })).rejects.toMatchObject({
      status: 400,
      code: 'language_not_runnable',
    })
  })

  it('refuses everything when execution is switched off', async () => {
    env.ALLOW_CODE_EXECUTION = false

    await expect(run('console.log(1)')).rejects.toMatchObject({
      status: 403,
      code: 'execution_disabled',
    })
  })

  it('refuses to start more programs than it will run at once', async () => {
    env.RUN_MAX_CONCURRENT = 1
    env.RUN_TIMEOUT_MS = 2000

    const slow = run('setTimeout(() => console.log("done"), 400)')
    await expect(run('console.log(1)')).rejects.toMatchObject({
      status: 429,
      code: 'runner_busy',
    })

    // The first one is unaffected, and the slot frees up after it.
    expect((await slow).stdout).toBe('done\n')
    expect((await run('console.log(1)')).ok).toBe(true)
  })

  /**
   * Each language for real, where the machine can. Skipped rather than failed
   * when a toolchain is missing: a laptop without a JDK is not a broken
   * runner, and CI should not need every compiler installed to prove the rest.
   */
  it.each([
    ['python', 'print("hi from " + "python")', 'hi from python'],
    ['typescript', 'const who: string = "typescript"\nconsole.log("hi from " + who)', 'hi from typescript'],
    ['java', 'public class Main { public static void main(String[] a) { System.out.println("hi from java"); } }', 'hi from java'],
    ['cpp', '#include <iostream>\nint main(){ std::cout << "hi from cpp\\n"; }', 'hi from cpp'],
    ['go', 'package main\nimport "fmt"\nfunc main(){ fmt.Println("hi from go") }', 'hi from go'],
    ['rust', 'fn main(){ println!("hi from rust"); }', 'hi from rust'],
  ])('runs %s when the toolchain is installed', async (language, code, expected) => {
    const languages = await listRunnable()
    const entry = languages.find((item) => item.language === language)
    if (!entry?.available) return

    // Compiling is slower than interpreting; give the compiled ones room.
    env.RUN_TIMEOUT_MS = 20000

    const result = await runCode({ language, code })
    expect(result.stdout.trim(), result.stderr).toBe(expected)
    expect(result.ok).toBe(true)
  }, 60000)

  it('gives the slot back even when a run cannot be set up at all', async () => {
    env.RUN_MAX_CONCURRENT = 1

    // A language whose recipe exists but whose source file cannot be written.
    const broken = { language: 'javascript', code: 'console.log(1)' }
    const failing = runCode({ ...broken, code: { toString: null } })
    await expect(failing).rejects.toBeTruthy()

    // If the slot had leaked, this would be refused as busy forever after.
    expect((await run('console.log("still works")')).stdout).toBe('still works\n')
  })

  it('reports which toolchains this machine actually has', async () => {
    const languages = await listRunnable()
    const javascript = languages.find((entry) => entry.language === 'javascript')

    expect(javascript.available).toBe(true)
    expect(javascript.version).toMatch(/^v\d+/)
    // Every runnable language is described, installed or not.
    expect(languages.map((entry) => entry.language)).toContain('rust')
    expect(languages.every((entry) => typeof entry.available === 'boolean')).toBe(true)
  })
})
