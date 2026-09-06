import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRedactor } from '../src/services/execution/redact.js'

/**
 * What a program prints goes to everyone in the room, including a public one.
 *
 * The runtime writes stack traces, not the person who pressed Run, and it
 * names files by their real path — which on the machine this was written on
 * spells out the operating system, the account the server runs as, and where
 * its temporary files live.
 */

const WORK = path.join(os.tmpdir(), 'syncspace-run-eRwD1I')

describe('hiding the host from program output', () => {
  const redact = createRedactor({ workDir: WORK })

  /** The exact leak this was written for, reproduced from a real run. */
  it('turns a stack trace into a path the author recognises', () => {
    const trace = path.join(WORK, 'main.js') + ':1\nthrow new Error("boom")'

    expect(redact(trace)).toBe('main.js:1\nthrow new Error("boom")')
  })

  /**
   * Node prints backslashes on Windows; a tool it invoked may print forward
   * slashes for the same directory. Knowing only one shape is worse than
   * knowing neither, because the output then looks redacted.
   */
  it('recognises the same directory written either way', () => {
    const forward = WORK.split(path.sep).join('/') + '/main.js:1:7'

    expect(redact('at Object.<anonymous> (' + forward + ')')).toBe('at Object.<anonymous> (main.js:1:7)')
  })

  /**
   * `/tmp` is the stand-in, which makes this test read differently on the two
   * platforms it has to pass on — and asserting the Windows reading alone was
   * how it broke on CI. On Linux the temp directory already *is* `/tmp`: there
   * is nothing to conceal and the path comes back untouched, correctly. On
   * Windows it is buried under the user's profile, and the whole prefix has to
   * go. Only the second case has something to assert the absence of.
   */
  it('names no temporary directory of its own, even one it did not run in', () => {
    const elsewhere = path.join(os.tmpdir(), 'something-else', 'a.txt')

    const out = redact('could not open ' + elsewhere)

    expect(out).toContain('/tmp')
    if (os.tmpdir() !== '/tmp') expect(out).not.toContain(os.tmpdir())
  })

  it('hides the account the server runs as', () => {
    const account = process.env.USERNAME || process.env.USER || process.env.LOGNAME
    if (!account) return

    expect(redact('reading /home/' + account + '/.ssh/id_rsa')).not.toContain(account)
  })

  it('hides the machine name', () => {
    const host = os.hostname()
    if (!host || host.length <= 2) return

    expect(redact('connected to ' + host)).not.toContain(host)
  })

  it('leaves ordinary output completely alone', () => {
    const normal = 'hello\n42\nDone in 0.3s\n'
    expect(redact(normal)).toBe(normal)
  })

  it('says nothing about empty output', () => {
    expect(redact('')).toBe('')
    expect(redact(null)).toBe(null)
  })
})

/**
 * The same rewriting, on the platform CI runs.
 *
 * Everything above is exercised against whichever machine happens to run it,
 * which in practice means Windows here and Linux on CI — and the two read
 * very differently, because `/tmp` is both the stand-in this uses and the
 * real answer on one of them. A test written against one shape passed locally
 * and failed on CI, so both shapes are pinned here rather than left to
 * whichever host turns up.
 */
describe('on a host whose temp directory is already /tmp', () => {
  afterEach(() => vi.restoreAllMocks())

  const linux = () => {
    vi.spyOn(os, 'tmpdir').mockReturnValue('/tmp')
    vi.spyOn(os, 'homedir').mockReturnValue('/home/runner')
    vi.spyOn(os, 'hostname').mockReturnValue('fv-az123-456')
    return createRedactor({ workDir: '/tmp/syncspace-run-eRwD1I' })
  }

  it('still removes the directory the run happened in', () => {
    expect(linux()('/tmp/syncspace-run-eRwD1I/main.js:1')).toBe('main.js:1')
  })

  /**
   * Unchanged, and correctly so: there is nothing private about `/tmp` on a
   * machine where that is what the temp directory is called. Asserting its
   * absence here is what broke on CI.
   */
  it('leaves an unrelated /tmp path exactly as it was', () => {
    expect(linux()('could not open /tmp/something-else/a.txt')).toBe(
      'could not open /tmp/something-else/a.txt'
    )
  })

  it('still hides the home directory and the machine name', () => {
    const redact = linux()

    expect(redact('reading /home/runner/.ssh/id_rsa')).toBe('reading ~/.ssh/id_rsa')
    expect(redact('connected to fv-az123-456')).toBe('connected to host')
  })
})
