import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
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

  it('names no temporary directory of its own, even one it did not run in', () => {
    const elsewhere = path.join(os.tmpdir(), 'something-else', 'a.txt')

    const out = redact('could not open ' + elsewhere)
    expect(out).not.toContain(os.tmpdir())
    // The separator after it is whatever the platform prints; the point is
    // that the real location is gone and something readable stands in.
    expect(out).toContain('/tmp')
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
