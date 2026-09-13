import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyPatch, describeChange, diffBounds, COPILOT_ORIGIN } from './textPatch.js'

/**
 * Applying a model's proposal to a document other people are editing.
 *
 * Two things are being protected. The buffer, obviously — a patch must never
 * land on top of typing that happened while the model was thinking. And the
 * document's shape: a whole-buffer rewrite would move every cursor, break
 * every comment anchored to a line, and record the entire file as changed, all
 * to alter one line.
 */

const docWith = (text) => {
  const doc = new Y.Doc()
  const yText = doc.getText('code')
  yText.insert(0, text)
  return { doc, yText }
}

describe('diffBounds', () => {
  it('answers nothing when the two are the same', () => {
    expect(diffBounds('same', 'same')).toBeNull()
  })

  it('finds a change in the middle and leaves the rest alone', () => {
    expect(diffBounds('a - b', 'a + b')).toEqual({ start: 2, removed: 1, inserted: '+' })
  })

  it('finds an insertion', () => {
    expect(diffBounds('ac', 'abc')).toEqual({ start: 1, removed: 0, inserted: 'b' })
  })

  it('finds a deletion', () => {
    expect(diffBounds('abc', 'ac')).toEqual({ start: 1, removed: 1, inserted: '' })
  })

  it('handles one side being empty', () => {
    expect(diffBounds('', 'hello')).toEqual({ start: 0, removed: 0, inserted: 'hello' })
    expect(diffBounds('hello', '')).toEqual({ start: 0, removed: 5, inserted: '' })
  })

  it('always describes an edit that actually produces the second string', () => {
    const pairs = [
      ['function add(a, b) { return a - b }', 'function add(a, b) { return a + b }'],
      ['one\ntwo\nthree', 'one\ntwo and a half\nthree'],
      ['one\ntwo\nthree', 'one\nthree'],
      ['abcabc', 'abc'],
      ['', ''],
      ['x', 'y'],
    ]

    for (const [before, after] of pairs) {
      const bounds = diffBounds(before, after)
      const result = bounds
        ? before.slice(0, bounds.start) + bounds.inserted + before.slice(bounds.start + bounds.removed)
        : before
      expect(result, before + ' → ' + after).toBe(after)
    }
  })

  /** Half an emoji is not a character. */
  it('never splits a surrogate pair', () => {
    const bounds = diffBounds('a🎉b', 'a🎉c')
    const result = 'a🎉b'.slice(0, bounds.start) + bounds.inserted + 'a🎉b'.slice(bounds.start + bounds.removed)
    expect(result).toBe('a🎉c')
    // The boundary sits between whole characters, never inside the pair.
    expect('a🎉b'.charCodeAt(bounds.start)).not.toBeGreaterThanOrEqual(0xdc00)
  })

  it('replaces an emoji with another without producing a lone surrogate', () => {
    const before = 'say 🎉 now'
    const after = 'say 🚀 now'
    const bounds = diffBounds(before, after)
    const result = before.slice(0, bounds.start) + bounds.inserted + before.slice(bounds.start + bounds.removed)
    expect(result).toBe(after)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result)).toBe(false)
  })
})

describe('applyPatch', () => {
  it('applies a change and leaves the buffer reading as proposed', () => {
    const { yText } = docWith('function add(a, b) {\n  return a - b\n}')
    const contents = 'function add(a, b) {\n  return a + b\n}'

    const result = applyPatch(yText, { baseText: yText.toString(), contents })

    expect(result).toEqual({ applied: true, reason: null })
    expect(yText.toString()).toBe(contents)
  })

  /**
   * The reason this function exists. Somebody typed while the model was
   * thinking, so the approval was given for text that is no longer there.
   */
  it('refuses when the buffer has moved since the model read it', () => {
    const { yText } = docWith('const a = 1')
    const baseText = yText.toString()

    yText.insert(yText.length, '\nconst b = 2')

    const result = applyPatch(yText, { baseText, contents: 'const a = 99' })

    expect(result).toEqual({ applied: false, reason: 'stale' })
    expect(yText.toString()).toBe('const a = 1\nconst b = 2')
  })

  it('says so rather than writing when the proposal is what is already there', () => {
    const { yText } = docWith('unchanged')
    expect(applyPatch(yText, { baseText: 'unchanged', contents: 'unchanged' })).toEqual({
      applied: false,
      reason: 'unchanged',
    })
  })

  /**
   * One update, not two, and not one per character. A whole-buffer rewrite
   * would be a single update too — but it would be one that says every
   * character changed, which is what moves everybody's cursor.
   */
  it('touches only the part that differs', () => {
    const { doc, yText } = docWith('line one\nline two\nline three')

    const updates = []
    doc.on('update', (update) => updates.push(update))

    applyPatch(yText, {
      baseText: yText.toString(),
      contents: 'line one\nline TWO\nline three',
    })

    expect(updates).toHaveLength(1)

    // What survived is what matters: a position in the untouched tail still
    // points at the same character, which is how a comment anchor stays put.
    const anchor = Y.createRelativePositionFromTypeIndex(yText, 'line one\nline two\n'.length)
    expect(Y.createAbsolutePositionFromRelativePosition(anchor, doc).index).toBe(
      'line one\nline TWO\n'.length
    )
  })

  it('marks the change as the copilot, so undo groups it as one step', () => {
    const { doc, yText } = docWith('before')

    const origins = []
    doc.on('afterTransaction', (transaction) => origins.push(transaction.origin))

    applyPatch(yText, { baseText: 'before', contents: 'after' })

    expect(origins).toContain(COPILOT_ORIGIN)
  })

  it('is undone in one step', () => {
    const { doc, yText } = docWith('function add(a, b) {\n  return a - b\n}')
    const undo = new Y.UndoManager(yText, { trackedOrigins: new Set([COPILOT_ORIGIN]) })

    applyPatch(yText, {
      baseText: yText.toString(),
      contents: 'function add(a, b) {\n  return a + b\n}',
    })

    undo.undo()
    expect(yText.toString()).toBe('function add(a, b) {\n  return a - b\n}')
    doc.destroy()
  })

  it('does nothing without a buffer to apply to', () => {
    expect(applyPatch(null, { baseText: '', contents: 'x' })).toEqual({
      applied: false,
      reason: 'no_buffer',
    })
  })
})

describe('describeChange', () => {
  it('says nothing changed when nothing did', () => {
    expect(describeChange('same', 'same').changed).toBe(false)
  })

  it('shows the whole line, not the three characters inside it', () => {
    const change = describeChange('one\ntwo\nthree', 'one\ntwoish\nthree')

    expect(change.changed).toBe(true)
    expect(change.removed).toEqual(['two'])
    expect(change.added).toEqual(['twoish'])
    expect(change.firstLine).toBe(2)
  })

  it('reports an added line as an addition with nothing removed', () => {
    const change = describeChange('one\nthree', 'one\ntwo\nthree')
    expect(change.added).toEqual(['two', 'three'])
  })

  it('reports a change on the first line', () => {
    const change = describeChange('const a = 1\nconst b = 2', 'const a = 99\nconst b = 2')
    expect(change.firstLine).toBe(1)
    expect(change.removed).toEqual(['const a = 1'])
    expect(change.added).toEqual(['const a = 99'])
  })
})
