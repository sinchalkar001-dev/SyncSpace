import { describe, expect, it } from 'vitest'
import {
  actionsIn,
  awaitingReview,
  blockerFor,
  bySeverity,
  describeSource,
  detectContext,
  filledBlocks,
  inputFor,
  RUN_IS_RECENT_MS,
} from './copilot.js'

/**
 * The two decisions that make the panel feel like it is paying attention.
 *
 * Getting the context wrong is not a crash, which is why it needs tests: it is
 * a copilot that offers to explain the architecture while somebody is staring
 * at a stack trace, and nobody files that as a bug.
 */

const REVIEW = { id: 'code.review', context: 'code', needs: null, sources: ['code', 'selection'] }
const EXPLAIN = { id: 'code.explain', context: 'code', needs: 'selection', sources: ['selection'] }
const MOMENT = { id: 'replay.moment', context: 'replay', needs: 'seq', sources: ['moment', 'timeline'] }
const COMPARE = { id: 'replay.compare', context: 'replay', needs: 'range', sources: ['versions'] }
const DIAGNOSE = { id: 'execution.diagnose', context: 'execution', needs: null, sources: ['run', 'code'] }

describe('detectContext', () => {
  it('follows the pane when there is nothing stronger to go on', () => {
    expect(detectContext({ paneMode: 'board' })).toBe('whiteboard')
    expect(detectContext({ paneMode: 'code' })).toBe('code')
  })

  /** Split view, nothing selected, nothing run: no surface is being pointed at. */
  it('treats an unfocused split view as being about the room', () => {
    expect(detectContext({ paneMode: 'split' })).toBe('room')
  })

  it('lets a replay win over everything', () => {
    expect(detectContext({ paneMode: 'board', replayOpen: true, hasSelection: true })).toBe('replay')
  })

  it('lets a selection win over the pane', () => {
    expect(detectContext({ paneMode: 'board', hasSelection: true })).toBe('code')
  })

  it('moves to the runs when something has just failed', () => {
    const now = 1_000_000
    expect(
      detectContext({ paneMode: 'code', lastRun: { ok: false, at: now - 5_000 }, now })
    ).toBe('execution')
  })

  /** An hour later that failure is history, not what you are looking at. */
  it('lets a stale failure go', () => {
    const now = 1_000_000
    expect(
      detectContext({
        paneMode: 'board',
        lastRun: { ok: false, at: now - RUN_IS_RECENT_MS - 1 },
        now,
      })
    ).toBe('whiteboard')
  })

  /** People run code that works and carry on with what they were doing. */
  it('does not move for a run that succeeded', () => {
    const now = 1_000_000
    expect(detectContext({ paneMode: 'board', lastRun: { ok: true, at: now - 1000 }, now })).toBe(
      'whiteboard'
    )
  })

  it('follows the surface somebody is actually working in, over the layout', () => {
    expect(detectContext({ paneMode: 'split', focusedSurface: 'board' })).toBe('whiteboard')
    expect(detectContext({ paneMode: 'split', focusedSurface: 'code' })).toBe('code')
  })

  it('answers something sensible when told nothing', () => {
    expect(detectContext()).toBe('room')
  })
})

describe('blockerFor', () => {
  const ready = {
    signedIn: true,
    enabled: true,
    allowed: true,
    hasSelection: true,
    hasMoment: true,
    hasRange: true,
    hasRuns: true,
  }

  it('lets a ready action through', () => {
    expect(blockerFor(REVIEW, ready)).toBeNull()
  })

  it('explains a deployment with no model before anything else', () => {
    const blocked = blockerFor(REVIEW, { ...ready, enabled: false, reason: 'No key is configured.' })
    expect(blocked).toBe('No key is configured.')
  })

  it('asks a guest to sign in', () => {
    expect(blockerFor(REVIEW, { ...ready, signedIn: false })).toMatch(/Sign in/)
  })

  it('passes the server’s own wording on when a role is refused', () => {
    const blocked = blockerFor(REVIEW, { ...ready, allowed: false, reason: 'Not your room.' })
    expect(blocked).toBe('Not your room.')
  })

  it('asks for what an action said it needs', () => {
    expect(blockerFor(EXPLAIN, { ...ready, hasSelection: false })).toMatch(/Select some code/)
    expect(blockerFor(MOMENT, { ...ready, hasMoment: false })).toMatch(/Pause the replay/)
    expect(blockerFor(COMPARE, { ...ready, hasRange: false })).toMatch(/two points/)
  })

  /** An action about runs, in a room where nothing has ever run. */
  it('says there is nothing to look at when nothing has run', () => {
    expect(blockerFor(DIAGNOSE, { ...ready, hasRuns: false })).toMatch(/Run the code first/)
  })

  it('does not block an action that needs no selection when there is none', () => {
    expect(blockerFor(REVIEW, { ...ready, hasSelection: false })).toBeNull()
  })

  it('blocks everything while an answer is still arriving', () => {
    expect(blockerFor(REVIEW, { ...ready, busy: true })).toMatch(/Wait for/)
  })
})

describe('inputFor', () => {
  it('sends a selection to an action that only supplements with one', () => {
    const input = inputFor(REVIEW, { selection: { startLine: 4, endLine: 9 } })
    expect(input).toEqual({ action: 'code.review', startLine: 4, endLine: 9 })
  })

  it('treats a caret as a one-line selection', () => {
    expect(inputFor(EXPLAIN, { selection: { startLine: 7 } })).toEqual({
      action: 'code.explain',
      startLine: 7,
      endLine: 7,
    })
  })

  it('sends nothing it was not given', () => {
    expect(inputFor(REVIEW, {})).toEqual({ action: 'code.review' })
  })

  it('sends the point a replay is paused on', () => {
    expect(inputFor(MOMENT, { seq: 42 })).toEqual({ action: 'replay.moment', seq: 42 })
  })

  it('sends a range, falling back to the paused point as the end', () => {
    expect(inputFor(COMPARE, { range: { fromSeq: 10 }, seq: 40 })).toEqual({
      action: 'replay.compare',
      fromSeq: 10,
      toSeq: 40,
    })
  })

  it('names a run only for an action that reads one', () => {
    expect(inputFor(DIAGNOSE, { executionId: 'x1' }).executionId).toBe('x1')
    expect(inputFor(REVIEW, { executionId: 'x1' }).executionId).toBeUndefined()
  })

  it('carries what the person typed', () => {
    expect(inputFor(REVIEW, { note: 'focus on the parser' }).note).toBe('focus on the parser')
  })
})

describe('presenting an answer', () => {
  it('puts the worst findings first', () => {
    const sorted = bySeverity([
      { title: 'c', severity: 'low' },
      { title: 'a', severity: 'high' },
      { title: 'b', severity: 'medium' },
    ])
    expect(sorted.map((finding) => finding.title)).toEqual(['a', 'b', 'c'])
  })

  it('does not reorder findings of the same severity', () => {
    const sorted = bySeverity([
      { title: 'first', severity: 'high' },
      { title: 'second', severity: 'high' },
    ])
    expect(sorted.map((finding) => finding.title)).toEqual(['first', 'second'])
  })

  /** An empty list is a real answer; a heading with nothing under it is not. */
  it('lists only the blocks with something in them', () => {
    const run = {
      result: { findings: [{ title: 'x' }], questions: [], steps: [{ step: 'y' }] },
    }
    expect(filledBlocks(run)).toEqual(['findings', 'steps'])
  })

  it('finds no blocks in an answer that is only prose', () => {
    expect(filledBlocks({ result: { answer: 'just words' } })).toEqual([])
    expect(filledBlocks(null)).toEqual([])
  })

  it('knows when something is still waiting to be decided', () => {
    expect(awaitingReview({ files: [{ status: 'proposed' }] })).toBe(true)
    expect(awaitingReview({ patch: { status: 'proposed' } })).toBe(true)
    expect(awaitingReview({ files: [{ status: 'applied' }], patch: { status: 'stale' } })).toBe(false)
    expect(awaitingReview(null)).toBe(false)
  })

  /**
   * A source that found nothing still gets a chip. Omitting it would leave a
   * reader assuming the answer was based on it.
   */
  it('says a source was read and empty, rather than leaving it out', () => {
    expect(describeSource({ label: 'Recent runs', detail: 'nothing recorded yet', present: false }))
      .toBe('Recent runs — nothing to read')
    expect(describeSource({ label: 'Shared code buffer', detail: '84 lines', present: true })).toBe(
      'Shared code buffer — 84 lines'
    )
  })
})

describe('actionsIn', () => {
  it('keeps the registry’s own order', () => {
    const actions = [REVIEW, MOMENT, EXPLAIN, DIAGNOSE]
    expect(actionsIn(actions, 'code').map((action) => action.id)).toEqual([
      'code.review',
      'code.explain',
    ])
  })

  it('survives being handed nothing', () => {
    expect(actionsIn(undefined, 'code')).toEqual([])
  })
})
