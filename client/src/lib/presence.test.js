import { describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_MS,
  IDLE_MS,
  MAX_SELECTED,
  PRESENCE_VERSION,
  SNAP_DISTANCE,
  activityOf,
  buildPresence,
  canFocus,
  canFollow,
  centerOn,
  createNavigator,
  describePresence,
  fileNameFor,
  stepCursor,
  viewCenter,
} from './presence.js'

/**
 * What a collaborator's presence says, and how it is allowed to say it.
 *
 * These are the rules every status line in the room is built from, so they
 * are tested directly rather than through a rendered menu: a wrong answer here
 * is a wrong answer everywhere somebody's activity is shown.
 */

const NOW = 1_000_000
const recent = NOW - 100

describe('working out what somebody is doing', () => {
  it('calls typing in the code editing, and lets it wear off', () => {
    const typing = { surface: 'code', lastTypedAt: recent, lastInputAt: recent, now: NOW }
    expect(activityOf(typing)).toBe('editing')
    expect(activityOf({ ...typing, lastTypedAt: NOW - ACTIVE_MS - 1 })).toBe('reading')
  })

  /**
   * A viewer can type into a focused editor all day; the connection is read
   * only and none of it reaches anybody. Reporting them as editing would tell
   * the room something false.
   */
  it('never reports somebody as editing what they are not allowed to edit', () => {
    expect(
      activityOf({ surface: 'code', lastTypedAt: recent, lastInputAt: recent, canEditCode: false, now: NOW })
    ).toBe('reading')
    expect(
      activityOf({ surface: 'board', lastDrewAt: recent, lastInputAt: recent, canEditBoard: false, now: NOW })
    ).toBe('browsing')
  })

  it('tells drawing from selecting from looking', () => {
    const board = { surface: 'board', lastInputAt: recent, now: NOW }
    expect(activityOf({ ...board, lastDrewAt: recent })).toBe('drawing')
    expect(activityOf({ ...board, selectedCount: 2 })).toBe('selecting')
    expect(activityOf(board)).toBe('browsing')
  })

  it('goes idle after a minute of nothing, and away when the tab is hidden', () => {
    expect(activityOf({ surface: 'code', lastInputAt: NOW - IDLE_MS - 1, now: NOW })).toBe('idle')
    expect(
      activityOf({ surface: 'code', lastTypedAt: recent, lastInputAt: recent, hidden: true, now: NOW })
    ).toBe('away')
  })
})

describe('the presence field on the wire', () => {
  it('carries the file and line only while in the code', () => {
    const inCode = buildPresence({ activity: 'editing', surface: 'code', line: 42, file: 'Main.java' })
    expect(inCode).toMatchObject({ surface: 'code', line: 42, file: 'Main.java', share: true })

    const onBoard = buildPresence({ activity: 'drawing', surface: 'board', line: 42, file: 'Main.java' })
    expect(onBoard).toMatchObject({ surface: 'board', line: null, file: null })
  })

  /**
   * Hiding location on the receiving end would mean trusting every other
   * client to look away. It is never sent instead.
   */
  it('sends no location at all when sharing is off', () => {
    const hidden = buildPresence({
      activity: 'editing',
      surface: 'code',
      line: 42,
      file: 'Main.java',
      selected: ['a', 'b'],
      sharing: false,
    })

    expect(hidden).toEqual({
      v: PRESENCE_VERSION,
      activity: 'present',
      surface: null,
      file: null,
      line: null,
      selected: null,
      share: false,
      following: null,
    })

    expect(buildPresence({ activity: 'away', sharing: false }).activity).toBe('away')
  })

  it('caps how many selected shapes it names', () => {
    const many = Array.from({ length: 40 }, (_, i) => 'shape-' + i)
    expect(buildPresence({ surface: 'board', selected: many }).selected).toHaveLength(MAX_SELECTED)
  })

  /** "Has anything changed" is a string compare, so equal states must be equal strings. */
  it('serialises the same state to the same string every time', () => {
    const one = buildPresence({ activity: 'reading', surface: 'code', line: 7, file: 'main.py' })
    const two = buildPresence({ file: 'main.py', line: 7, surface: 'code', activity: 'reading' })
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
  })
})

describe('saying it', () => {
  const presence = (over) => ({ v: PRESENCE_VERSION, share: true, ...over })

  it('reads the way the room shows it', () => {
    expect(
      describePresence(presence({ activity: 'editing', file: 'Main.java', line: 42 }))
    ).toEqual({ tone: 'active', status: 'Editing Main.java', place: 'Line 42' })

    expect(describePresence(presence({ activity: 'drawing' }))).toEqual({
      tone: 'active',
      status: 'Drawing',
      place: 'Whiteboard',
    })
  })

  it('counts a selection without getting the plural wrong', () => {
    expect(describePresence(presence({ activity: 'selecting', selected: ['a'] })).place).toBe(
      '1 object on the whiteboard'
    )
    expect(describePresence(presence({ activity: 'selecting', selected: ['a', 'b'] })).place).toBe(
      '2 objects on the whiteboard'
    )
  })

  it('marks idle and away in their own tones', () => {
    expect(describePresence(presence({ activity: 'idle' })).tone).toBe('idle')
    expect(describePresence(presence({ activity: 'away' }))).toMatchObject({ tone: 'away', status: 'Away' })
  })

  it('says only that somebody is here when they are not sharing', () => {
    expect(describePresence({ v: PRESENCE_VERSION, activity: 'present', share: false })).toEqual({
      tone: 'active',
      status: 'Online',
      place: 'Not sharing activity',
    })
  })

  /** A client from before presence existed sends nothing, and must not read as broken. */
  it('treats a client with no presence as simply online', () => {
    expect(describePresence(null)).toEqual({ tone: 'active', status: 'Online', place: null })
  })
})

describe('who can be followed, and who can be found', () => {
  const user = { name: 'Ayush' }

  it('follows and focuses somebody who is sharing', () => {
    const peer = { user, presence: { v: PRESENCE_VERSION, share: true } }
    expect(canFollow(peer)).toBe(true)
    expect(canFocus(peer)).toBe(true)
  })

  it('does neither for somebody who has turned sharing off', () => {
    const peer = { user, presence: { v: PRESENCE_VERSION, share: false }, cursor: { x: 1, y: 1 } }
    expect(canFollow(peer)).toBe(false)
    expect(canFocus(peer)).toBe(false)
  })

  it('can still jump to an older client that has a pointer, but not follow it', () => {
    expect(canFocus({ user, cursor: { x: 1, y: 1 } })).toBe(true)
    expect(canFollow({ user, cursor: { x: 1, y: 1 } })).toBe(false)
    expect(canFocus({ user })).toBe(false)
  })
})

describe('the board from somebody else point of view', () => {
  /**
   * The same stage offset frames different parts of the board on a laptop and
   * a monitor. The centre does not, which is why that is what gets sent.
   */
  it('keeps the same point in the middle of a screen of a different size', () => {
    const laptop = { width: 1280, height: 720 }
    const monitor = { width: 1920, height: 1080 }

    const center = viewCenter({ scale: 2, x: -300, y: -100 }, laptop)
    const framed = centerOn(center, monitor)

    expect((monitor.width / 2 - framed.x) / framed.scale).toBeCloseTo(center.cx)
    expect((monitor.height / 2 - framed.y) / framed.scale).toBeCloseTo(center.cy)
    expect(framed.scale).toBe(2)
  })
})

describe('easing a cursor between samples', () => {
  const origin = { x: 0, y: 0 }
  const target = { x: 100, y: 0 }

  it('puts a cursor seen for the first time straight where it is', () => {
    expect(stepCursor(null, target, 16)).toEqual({ x: 100, y: 0, settled: true })
  })

  it('closes part of the distance each frame rather than jumping', () => {
    const next = stepCursor(origin, target, 16)
    expect(next.x).toBeGreaterThan(0)
    expect(next.x).toBeLessThan(100)
    expect(next.settled).toBe(false)
  })

  it('arrives, and says so, so the frame loop can stop', () => {
    let at = origin
    for (let frame = 0; frame < 60 && !at.settled; frame += 1) at = stepCursor(at, target, 16)
    expect(at).toEqual({ x: 100, y: 0, settled: true })
  })

  it('teleports rather than gliding across the whole board', () => {
    const far = { x: SNAP_DISTANCE + 1, y: 0 }
    expect(stepCursor(origin, far, 16)).toEqual({ ...far, settled: true })
  })

  /**
   * The same wall-clock time must cover the same distance whether it arrives
   * as one frame or two, or a 144Hz monitor and a throttled tab would disagree
   * about how fast somebody's pointer is moving.
   */
  it('moves the same distance in the same time at any frame rate', () => {
    const once = stepCursor(origin, target, 32)
    const twice = stepCursor(stepCursor(origin, target, 16), target, 16)
    expect(twice.x).toBeCloseTo(once.x, 6)
  })
})

describe('telling a pane where to look', () => {
  it('delivers to the surface that asked, and stops when told', () => {
    const navigator = createNavigator()
    const code = vi.fn()
    const board = vi.fn()

    const off = navigator.on('code', code)
    navigator.on('board', board)

    navigator.emit('code', { line: 12 })
    expect(code).toHaveBeenCalledWith({ line: 12 })
    expect(board).not.toHaveBeenCalled()

    off()
    navigator.emit('code', { line: 13 })
    expect(code).toHaveBeenCalledTimes(1)
  })
})

describe('the file a buffer is', () => {
  it('uses the name the buffer runs under', () => {
    expect(fileNameFor('java')).toBe('Main.java')
    expect(fileNameFor('python')).toBe('main.py')
    expect(fileNameFor('something-new')).toBe('main.txt')
  })
})
