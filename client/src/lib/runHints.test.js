import { describe, expect, it } from 'vitest'
import { hintFor } from './runHints.js'

const failed = (stderr) => ({ ok: false, exitCode: 1, stdout: '', stderr, timedOut: false })

describe('hintFor', () => {
  it('explains a Java Scanner that ran out of input', () => {
    const hint = hintFor(
      failed(
        'Exception in thread "main" java.util.NoSuchElementException\n' +
          '\tat java.base/java.util.Scanner.throwFor(Scanner.java:962)'
      ),
      ''
    )

    expect(hint.id).toBe('needs-input')
    expect(hint.message).toContain('input box was empty')
    expect(hint.action).toBe('Add input')
  })

  it('explains a Python input() with nothing to read', () => {
    expect(hintFor(failed('EOFError: EOF when reading a line'), '')?.id).toBe('needs-input')
  })

  /**
   * The hint's whole value is that it points somewhere real. Once there IS
   * input, the same exception means something else — bad input, or not enough
   * of it — and sending someone back to a box they already filled is worse
   * than staying quiet.
   */
  it('stays quiet when input was supplied', () => {
    expect(hintFor(failed('java.util.NoSuchElementException'), '5\n')).toBeNull()
  })

  it('stays quiet about failures it cannot explain', () => {
    expect(hintFor(failed('NullPointerException at Main.main(Main.java:12)'), '')).toBeNull()
    expect(hintFor(failed('SyntaxError: unexpected token'), '')).toBeNull()
  })

  it('says nothing about a run that worked', () => {
    expect(hintFor({ ok: true, exitCode: 0, stdout: 'Sum = 7', stderr: '' }, '')).toBeNull()
  })

  it('leaves a timeout alone, where the verdict already explains itself', () => {
    expect(hintFor({ ...failed('java.util.NoSuchElementException'), timedOut: true }, '')).toBeNull()
  })

  it('does not advise on a run someone else started', () => {
    const theirs = { ...failed('java.util.NoSuchElementException'), by: { name: 'Priya' } }
    expect(hintFor(theirs, '')).toBeNull()
  })

  it('handles a missing result', () => {
    expect(hintFor(null, '')).toBeNull()
  })
})
