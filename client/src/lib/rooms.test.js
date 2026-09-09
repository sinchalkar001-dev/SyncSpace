import { describe, expect, it } from 'vitest'
import {
  continueRoom,
  isMine,
  isShared,
  kindFilters,
  kindOf,
  partitionRooms,
  roomLabel,
  selectRooms,
  summarise,
} from './rooms.js'

/**
 * The functions the dashboard is actually made of.
 *
 * Everything the page shows - which rooms, in what order, under which heading -
 * comes out of here, and all of it runs on rooms already in memory rather than
 * on a request. That is what makes forty rooms as quick as four, and it is also
 * what makes these worth testing directly: a bug in `selectRooms` is a bug in
 * search, filtering and sorting at once.
 */

const DAY = 24 * 60 * 60 * 1000
const ago = (ms) => new Date(Date.now() - ms).toISOString()

const room = (over = {}) => ({
  roomId: 'aaaaaaaa',
  name: 'A room',
  description: '',
  kind: 'general',
  owner: 'me',
  isPublic: false,
  memberCount: 1,
  collaborators: [],
  pinned: false,
  archived: false,
  lastActivityAt: ago(30 * 60_000),
  updatedAt: ago(30 * 60_000),
  ...over,
})

describe('what a room is', () => {
  it('falls back to general for a kind it does not recognise', () => {
    expect(kindOf(room({ kind: 'retrospective' })).value).toBe('general')
    expect(kindOf(undefined).value).toBe('general')
  })

  it('leads an unnamed room with its code, so two are never identical', () => {
    expect(roomLabel(room({ name: 'Untitled room', roomId: 'Zx9' }))).toBe('Zx9')
    expect(roomLabel(room({ name: 'Real name' }))).toBe('Real name')
  })

  it('tells a room you own from one you were let into', () => {
    expect(isMine(room({ owner: 'me' }), 'me')).toBe(true)
    expect(isShared(room({ owner: 'me' }), 'me')).toBe(false)
    expect(isShared(room({ owner: 'them' }), 'me')).toBe(true)
    // An ad-hoc room has no owner, so it is neither.
    expect(isMine(room({ owner: null }), 'me')).toBe(false)
    expect(isShared(room({ owner: null }), 'me')).toBe(false)
  })

  it('counts each type so an empty filter is visibly empty before it is chosen', () => {
    const counts = kindFilters([room({ kind: 'coding' }), room({ kind: 'coding' })])
    expect(counts.find((f) => f.value === 'all').count).toBe(2)
    expect(counts.find((f) => f.value === 'coding').count).toBe(2)
    expect(counts.find((f) => f.value === 'interview').count).toBe(0)
  })
})

describe('narrowing a list of rooms', () => {
  // Explicit timestamps: the default sort is by activity, so leaving these to
  // chance would make the expected order depend on how fast the fixtures were
  // built rather than on anything the test means.
  const rooms = [
    room({ roomId: 'r1', name: 'Candidate screen', kind: 'interview', description: 'Two-sum', lastActivityAt: ago(1000) }),
    room({
      roomId: 'r2',
      name: 'Payments',
      kind: 'system-design',
      collaborators: [{ id: 'u2', name: 'Ayush' }],
      lastActivityAt: ago(2000),
    }),
    room({ roomId: 'r3', name: 'Kata', kind: 'coding', archived: true, lastActivityAt: ago(3000) }),
  ]

  it('hides archived rooms until they are asked for', () => {
    expect(selectRooms(rooms).map((r) => r.roomId)).toEqual(['r1', 'r2'])
    expect(selectRooms(rooms, { archived: true }).map((r) => r.roomId)).toEqual(['r3'])
  })

  it('filters by type', () => {
    expect(selectRooms(rooms, { kind: 'interview' }).map((r) => r.roomId)).toEqual(['r1'])
  })

  /**
   * Names alone would miss the two things people actually remember about a room
   * they cannot name: what it was for, and who was in it.
   */
  it('searches the code, the description and the people, not only the name', () => {
    expect(selectRooms(rooms, { query: 'r2' }).map((r) => r.roomId)).toEqual(['r2'])
    expect(selectRooms(rooms, { query: 'two-sum' }).map((r) => r.roomId)).toEqual(['r1'])
    expect(selectRooms(rooms, { query: 'ayush' }).map((r) => r.roomId)).toEqual(['r2'])
  })

  it('filters by whose room it is', () => {
    const mixed = [
      room({ roomId: 'mine', owner: 'me', lastActivityAt: ago(1000) }),
      room({ roomId: 'theirs', owner: 'them', lastActivityAt: ago(2000) }),
    ]
    expect(selectRooms(mixed, { owner: 'mine', userId: 'me' }).map((r) => r.roomId)).toEqual(['mine'])
    expect(selectRooms(mixed, { owner: 'shared', userId: 'me' }).map((r) => r.roomId)).toEqual(['theirs'])
  })

  it('sorts by activity, by name, by change and by size', () => {
    const set = [
      room({ roomId: 'old', name: 'Zebra', lastActivityAt: ago(5 * DAY), updatedAt: ago(DAY), memberCount: 9 }),
      room({ roomId: 'new', name: 'Apple', lastActivityAt: ago(1000), updatedAt: ago(9 * DAY), memberCount: 2 }),
    ]

    expect(selectRooms(set, { sort: 'recent' })[0].roomId).toBe('new')
    expect(selectRooms(set, { sort: 'updated' })[0].roomId).toBe('old')
    expect(selectRooms(set, { sort: 'name' })[0].name).toBe('Apple')
    expect(selectRooms(set, { sort: 'collaborators' })[0].roomId).toBe('old')
  })
})

describe('the rooms somebody put at the top', () => {
  /**
   * Pinned rooms keep the order they were pinned in rather than the sort chosen
   * for the grid. A hand-built list that rearranges itself when you change a
   * dropdown is not a hand-built list.
   */
  it('keeps pinned rooms in the order they were pinned, newest first', () => {
    const { pinned } = partitionRooms([
      room({ roomId: 'first', pinned: true, pinnedAt: ago(3 * DAY) }),
      room({ roomId: 'plain' }),
      room({ roomId: 'latest', pinned: true, pinnedAt: ago(60_000) }),
    ])

    expect(pinned.map((r) => r.roomId)).toEqual(['latest', 'first'])
  })

  it('leaves pinned rooms out of the main group, so none appears twice', () => {
    const { rest } = partitionRooms([room({ roomId: 'a', pinned: true }), room({ roomId: 'b' })])
    expect(rest.map((r) => r.roomId)).toEqual(['b'])
  })
})

describe('the room worth offering to go back to', () => {
  it('is the most recently active one', () => {
    const pick = continueRoom([
      room({ roomId: 'stale', lastActivityAt: ago(2 * DAY) }),
      room({ roomId: 'fresh', lastActivityAt: ago(60_000) }),
    ])
    expect(pick.roomId).toBe('fresh')
  })

  it('is never an archived room', () => {
    const pick = continueRoom([
      room({ roomId: 'filed', archived: true, lastActivityAt: ago(1000) }),
      room({ roomId: 'open', lastActivityAt: ago(2 * DAY) }),
    ])
    expect(pick.roomId).toBe('open')
  })

  /**
   * A prominent "resume" pointing at a fortnight-old room is not resuming
   * anything. Better to show nothing and let the empty dashboard say so.
   */
  it('is nothing at all once everything has gone quiet for a week', () => {
    expect(continueRoom([room({ lastActivityAt: ago(8 * DAY) })])).toBeNull()
    expect(continueRoom([])).toBeNull()
    expect(continueRoom([room({ lastActivityAt: null })])).toBeNull()
  })
})

describe('the figures in the header', () => {
  it('counts what is on the dashboard, not what is filed away', () => {
    const stats = summarise(
      [
        room({ roomId: 'a', owner: 'me', lastActivityAt: ago(1000) }),
        room({ roomId: 'b', owner: 'them', pinned: true }),
        room({ roomId: 'c', archived: true, owner: 'them' }),
      ],
      'me'
    )

    expect(stats).toMatchObject({ total: 2, live: 1, shared: 1, pinned: 1, archived: 1 })
  })
})
