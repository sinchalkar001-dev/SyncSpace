import { describe, expect, it } from 'vitest'
import {
  SECTION_LABELS,
  citationsOf,
  currentEventId,
  describeEvent,
  hasStatements,
  iconForKind,
  indexForSeq,
} from './sessionInsights.js'

/**
 * The glue between a summary's sentences and the replay they describe.
 *
 * Every citation in the panel seeks the replay, and every event in the list
 * can be the current one. Both depend on getting from a log position to a
 * scrubber position exactly right — off by one, and "Database added" opens
 * on the frame before the database was drawn.
 */

const ENTRIES = [{ seq: 1 }, { seq: 2 }, { seq: 5 }, { seq: 9 }]

describe('from a log position to the scrubber', () => {
  it('lands on the frame that shows the change, not the one before it', () => {
    expect(indexForSeq(ENTRIES, 1)).toBe(1)
    expect(indexForSeq(ENTRIES, 5)).toBe(3)
    expect(indexForSeq(ENTRIES, 9)).toBe(4)
  })

  it('shows the latest state at or before a position the log skipped', () => {
    expect(indexForSeq(ENTRIES, 4)).toBe(2)
    expect(indexForSeq(ENTRIES, 100)).toBe(4)
  })

  it('is the empty board before anything happened', () => {
    expect(indexForSeq(ENTRIES, 0)).toBe(0)
    expect(indexForSeq([], 5)).toBe(0)
  })
})

describe('the current event', () => {
  const events = [
    { id: 'e1', seq: 1 },
    { id: 'e2', seq: 5 },
    { id: 'e3', seq: 9 },
  ]

  it('is the newest one at or before the replay position', () => {
    expect(currentEventId(events, 6)).toBe('e2')
    expect(currentEventId(events, 9)).toBe('e3')
  })

  it('is nothing before the first event', () => {
    expect(currentEventId(events, 0)).toBeNull()
  })
})

describe('citations', () => {
  const cited = { e1: { clock: '00:00', seq: 1, text: 'API added' } }

  /** Resolved from the copy the summary carries, not from a timeline that may have moved. */
  it('resolves ids from the answer own copy of the events', () => {
    expect(citationsOf({ text: 't', events: ['e1', 'e7'] }, cited)).toEqual([
      { id: 'e1', clock: '00:00', seq: 1, text: 'API added' },
    ])
  })

  it('gives nothing for a statement with no citations', () => {
    expect(citationsOf({ text: 't', events: [] }, cited)).toEqual([])
    expect(citationsOf(null, cited)).toEqual([])
  })
})

describe('reading an event', () => {
  it('leads with the person when the event is about a person', () => {
    expect(describeEvent({ kind: 'people.joined', actor: 'Ayush', text: 'joined the room' })).toEqual({
      text: 'Ayush joined the room',
      by: null,
    })
  })

  it('leads with the work otherwise, and attributes it quietly', () => {
    expect(describeEvent({ kind: 'architecture.added', actor: 'Ada', text: 'Database added' })).toEqual({
      text: 'Database added',
      by: 'Ada',
    })
  })

  it('picks an icon by kind, and has one for kinds it does not know', () => {
    expect(iconForKind('execution.failed')).toBe('alert')
    expect(iconForKind('architecture.connected')).toBe('layers')
    expect(iconForKind('something.new')).toBe('activity')
  })

  it('names the summary sections a person reads a session in', () => {
    expect(SECTION_LABELS.map((section) => section.key)).toEqual([
      'decisions',
      'architecture',
      'code',
      'failed',
      'succeeded',
      'unresolved',
      'collaboration',
    ])
    expect(hasStatements({ code: [{ text: 'x', events: ['e1'] }] }, 'code')).toBe(true)
    expect(hasStatements({ code: [] }, 'code')).toBe(false)
  })
})
