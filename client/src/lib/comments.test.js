import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import {
  anchorLabel,
  codeAnchor,
  insertMention,
  mentionQuery,
  mentionSegments,
  mentionsIn,
  mergeThread,
  regionAnchor,
  resolveBoardAnchor,
  resolveCodeAnchors,
  shapeAnchor,
  threadAt,
  unreadOf,
} from './comments.js'

/**
 * Anchors that find their way back.
 *
 * Every test here moves the thing a comment points at — lines typed above it,
 * a shape dragged, the code deleted — and checks the comment still points at
 * the right place, or says honestly that the place is gone.
 */

function codeDoc(text) {
  const doc = new Y.Doc()
  const code = doc.getText('code')
  code.insert(0, text)
  return code
}

const range = (startLine, startColumn, endLine, endColumn) => ({
  startLineNumber: startLine,
  startColumn,
  endLineNumber: endLine,
  endColumn,
})

describe('a comment on code', () => {
  const SOURCE = 'function login(user) {\n  return check(user)\n}\n'

  it('stays with its line when lines are added above it', () => {
    const code = codeDoc(SOURCE)
    const anchor = codeAnchor(code, range(2, 3, 2, 21))
    expect(anchor).toMatchObject({ line: 2, endLine: 2, snippet: 'return check(user)' })

    code.insert(0, '// auth\n// helpers\n')

    const at = resolveCodeAnchors([{ id: 't1', anchor }], code).get('t1')
    expect(at).toMatchObject({ line: 4, endLine: 4, orphaned: false })
  })

  it('treats a click without a selection as the whole line', () => {
    const code = codeDoc(SOURCE)
    const anchor = codeAnchor(code, range(2, 5, 2, 5))
    expect(anchor.snippet).toBe('  return check(user)')
    expect(anchor.startColumn).toBe(1)
  })

  it('spans the lines of a selection that crosses them', () => {
    const code = codeDoc(SOURCE)
    const anchor = codeAnchor(code, range(1, 1, 3, 2))
    expect(anchor).toMatchObject({ line: 1, endLine: 3 })
    expect(anchorLabel(anchor)).toBe('Lines 1–3')
  })

  /**
   * Showing the comment on whatever line is left where the code used to be
   * would attach it to code it was never about.
   */
  it('says the code is gone when every character it was about is deleted', () => {
    const code = codeDoc(SOURCE)
    const anchor = codeAnchor(code, range(2, 1, 2, 21))

    code.delete(SOURCE.indexOf('  return'), '  return check(user)'.length)

    expect(resolveCodeAnchors([{ id: 't1', anchor }], code).get('t1').orphaned).toBe(true)
  })

  it('ignores a thread that is not about code', () => {
    const code = codeDoc(SOURCE)
    expect(resolveCodeAnchors([{ id: 't1', anchor: { kind: 'region', x: 1, y: 1 } }], code).size).toBe(0)
  })

  /** The same anchor must resolve on a historical copy of the document too - that is replay. */
  it('resolves against another copy of the same document', () => {
    const code = codeDoc(SOURCE)
    const anchor = codeAnchor(code, range(2, 3, 2, 21))

    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(code.doc))

    expect(resolveCodeAnchors([{ id: 't1', anchor }], copy.getText('code')).get('t1').line).toBe(2)
  })
})

describe('a comment on the board', () => {
  const box = { id: 's1', type: 'rect', x: 100, y: 100, width: 200, height: 100 }

  it('rides along when its shape is moved', () => {
    const anchor = shapeAnchor(box, { x: 150, y: 175 })
    expect(anchor).toMatchObject({ kind: 'shape', shapeId: 's1', offsetX: 0.25, offsetY: 0.75, label: 'Rectangle' })

    const moved = { ...box, x: 500, y: 40 }
    expect(resolveBoardAnchor(anchor, new Map([['s1', moved]]))).toMatchObject({ x: 550, y: 115, detached: false })
  })

  it('stays where the shape last was when the shape is deleted', () => {
    const anchor = shapeAnchor(box, { x: 150, y: 175 })
    expect(resolveBoardAnchor(anchor, new Map())).toMatchObject({ x: 150, y: 175, detached: true })
  })

  it('keeps a region as dragged, in either direction', () => {
    expect(regionAnchor({ x: 50, y: 60 }, { x: 10, y: 20 })).toEqual({
      kind: 'region',
      x: 10,
      y: 20,
      width: 40,
      height: 40,
    })
    expect(anchorLabel(regionAnchor({ x: 1, y: 1 }))).toBe('Whiteboard')
  })
})

describe('threads arriving out of order', () => {
  const thread = (version, status = 'open') => ({ id: 't1', version, status })

  /** An announcement can overtake the response to the request that caused it. */
  it('keeps the newer copy whichever arrives first', () => {
    const newer = mergeThread([thread(3, 'resolved')], thread(2, 'open'))
    expect(newer[0]).toMatchObject({ version: 3, status: 'resolved' })

    const updated = mergeThread([thread(2)], thread(3, 'resolved'))
    expect(updated[0].status).toBe('resolved')

    expect(mergeThread([], thread(1))).toHaveLength(1)
  })
})

describe('what is new', () => {
  const at = (minutes) => new Date(Date.UTC(2026, 8, 11, 10, minutes)).toISOString()
  const threads = [
    {
      id: 't1',
      messages: [
        { id: 'm1', author: 'me', createdAt: at(1), mentions: [] },
        { id: 'm2', author: 'ayush', createdAt: at(5), mentions: ['me'] },
        { id: 'm3', author: 'bo', createdAt: at(6), mentions: [] },
        { id: 'm4', author: 'bo', createdAt: at(7), mentions: [], deleted: true },
      ],
    },
  ]

  it('counts other people messages since the last look, and mentions separately', () => {
    expect(unreadOf(threads, { userId: 'me', seenAt: at(2) })).toEqual({ count: 2, mentions: 1 })
    expect(unreadOf(threads, { userId: 'me', seenAt: at(6) })).toEqual({ count: 0, mentions: 0 })
  })
})

describe('mentions', () => {
  it('knows when a name is being typed after an @', () => {
    expect(mentionQuery('hi @ay', 6)).toEqual({ start: 3, query: 'ay' })
    expect(mentionQuery('mail me@example', 15)).toBeNull()
    expect(mentionQuery('@ayush done', 11)).toBeNull()
  })

  it('replaces the typed part with the chosen name', () => {
    expect(insertMention('hi @ay', 3, 6, 'Ayush')).toEqual({ text: 'hi @Ayush ', caret: 10 })
  })

  /** The text is what the author sees, so a name deleted from it is no longer mentioned. */
  it('mentions only the people still named in the text', () => {
    const picked = [
      { id: 'u1', name: 'Ayush' },
      { id: 'u2', name: 'Bo' },
    ]
    expect(mentionsIn('@Ayush look', picked)).toEqual(['u1'])
  })

  it('highlights the names of the people mentioned, and nothing else', () => {
    expect(mentionSegments('ask @Ayush or @nobody', ['Ayush'])).toEqual([
      { text: 'ask ', mention: false },
      { text: '@Ayush', mention: true },
      { text: ' or @nobody', mention: false },
    ])
  })
})

describe('a thread in replay', () => {
  const thread = {
    id: 't1',
    status: 'resolved',
    createdSeq: 10,
    messages: [
      { id: 'm1', body: 'first' },
      { id: 'm2', body: 'second' },
    ],
    events: [
      { type: 'opened', seq: 10, messageId: 'm1' },
      { type: 'replied', seq: 20, messageId: 'm2' },
      { type: 'resolved', seq: 30 },
      { type: 'deleted', seq: 40, messageId: 'm2' },
    ],
  }

  it('does not exist before it was opened', () => {
    expect(threadAt(thread, 9)).toBeNull()
  })

  it('shows what had been said, and whether it was resolved, at each point', () => {
    expect(threadAt(thread, 15)).toMatchObject({ status: 'open', messages: [{ id: 'm1' }] })
    expect(threadAt(thread, 25).messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(threadAt(thread, 35).status).toBe('resolved')
  })

  /** A later deletion does not reach back and remove what was there at the time. */
  it('shows a message at the points where it existed, even if it was deleted later', () => {
    expect(threadAt(thread, 35).messages).toHaveLength(2)
    expect(threadAt(thread, 45).messages.map((message) => message.id)).toEqual(['m1'])
  })
})
