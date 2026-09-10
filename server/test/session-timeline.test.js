import * as Y from 'yjs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { DocUpdate } from '../src/models/DocUpdate.js'
import { Execution } from '../src/models/Execution.js'
import {
  SEGMENT_GAP_MS,
  buildSessionTimeline,
  clockOf,
  declarationsIn,
  lineDelta,
  momentAt,
  resetTimelineCache,
} from '../src/services/session-timeline.service.js'

/**
 * A room's history, read back as things that happened.
 *
 * The update log is written here exactly as the collab server writes it — one
 * row per Yjs update, with the time it landed and who sent it — so the
 * timeline is reading real updates, not a description of them. The times are
 * chosen, which is what lets these tests say "the database arrived at 10:00".
 */

const ROOM = 'timeline-room'
const T0 = new Date('2026-09-11T10:00:00.000Z').getTime()
const MIN = 60 * 1000
const ADA = '65f0000000000000000000a1'
const BO = '65f0000000000000000000b2'

let counter = 0
const id = () => 'sh' + (counter += 1)

/** A labelled box, the way somebody draws a component: a rect with text inside. */
const box = (label, x, y) => {
  const shapes = [{ id: id(), type: 'rect', x, y, width: 120, height: 60, stroke: '#fff', strokeWidth: 2 }]
  if (label) {
    shapes.push({ id: id(), type: 'text', x: x + 12, y: y + 22, text: label, fontSize: 16, stroke: '#fff' })
  }
  return shapes
}

const arrow = (from, to) => ({
  id: id(),
  type: 'arrow',
  x: 0,
  y: 0,
  points: [from.x, from.y, to.x, to.y],
  stroke: '#fff',
  strokeWidth: 2,
})

/** Writes each step's update to the log at its own time, as the server would. */
async function record(steps, roomId = ROOM) {
  const doc = new Y.Doc()
  const rows = []
  let seq = (await DocUpdate.countDocuments({ roomId })) || 0

  for (const step of steps) {
    const updates = []
    const collect = (update) => updates.push(update)
    doc.on('update', collect)
    doc.transact(() => step.apply(doc))
    doc.off('update', collect)

    for (const update of updates) {
      seq += 1
      rows.push({
        roomId,
        seq,
        update: Buffer.from(update),
        actor: step.actor ?? null,
        size: update.byteLength,
        createdAt: new Date(T0 + step.at),
      })
    }
  }

  // The driver, not the model: these rows carry chosen timestamps, and the
  // model's own timestamps would overwrite them with "now".
  await DocUpdate.collection.insertMany(rows)
  doc.destroy()
  return rows
}

const draw = (shapes) => (doc) => doc.getArray('shapes').push(shapes)
const type = (text, at = 0) => (doc) => doc.getText('code').insert(at, text)

async function run({ at, state, stderr = '', language = 'javascript', user = 'Ada' }) {
  await Execution.collection.insertOne({
    executionId: 'run-' + at,
    roomId: ROOM,
    language,
    state,
    stderr,
    userName: user,
    finishedAt: new Date(T0 + at),
    createdAt: new Date(T0 + at),
  })
}

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  resetTimelineCache()
})

describe('a session, read back as events', () => {
  async function aDesignSession() {
    await record([
      { at: 0, actor: ADA, apply: draw(box('API', 0, 0)) },
      { at: 4 * MIN, actor: ADA, apply: draw(box('Auth Service', 0, 200)) },
      { at: 10 * MIN, actor: BO, apply: draw(box('Database', 300, 0)) },
      { at: 11 * MIN, actor: BO, apply: draw([arrow({ x: 120, y: 30 }, { x: 300, y: 30 })]) },
      { at: 18 * MIN, actor: ADA, apply: type('function login(user) {\n  return check(user)\n}\n') },
    ])
    await run({ at: 22 * MIN, state: 'failed', stderr: 'TypeError: check is not defined\n    at login' })
    await run({ at: 31 * MIN, state: 'completed' })
  }

  it('says what was built, in the order it was built, and when', async () => {
    await aDesignSession()
    const { events } = await buildSessionTimeline(ROOM)

    const shown = events
      .filter((event) => !event.kind.startsWith('state.'))
      .map((event) => event.clock + ' ' + event.text)

    expect(shown).toEqual([
      '00:00 API added',
      '04:00 Auth Service added',
      '10:00 Database added',
      '11:00 API connected to Database',
      '18:00 Code: added login',
      '22:00 Run failed (javascript)',
      '31:00 Run succeeded (javascript)',
    ])
  })

  it('keeps the first line of what a failing run printed, and who did what', async () => {
    await aDesignSession()
    const { events } = await buildSessionTimeline(ROOM)

    const failure = events.find((event) => event.kind === 'execution.failed')
    expect(failure.detail).toBe('TypeError: check is not defined')

    // Nobody signed up as these ids, so they read as somebody rather than
    // as a raw id; runs carry the name they were started under.
    expect(events.find((event) => event.text === 'API added').actor).toBe('Someone')
    expect(failure.actor).toBe('Ada')
  })

  it('points every event at a place in the log the replay can seek to', async () => {
    await aDesignSession()
    const { events, throughSeq } = await buildSessionTimeline(ROOM)

    for (const event of events) {
      expect(event.seq).toBeGreaterThanOrEqual(1)
      expect(event.seq).toBeLessThanOrEqual(throughSeq)
    }

    // A run lands between edits, so it seeks to the last edit before it.
    const code = events.find((event) => event.kind === 'code.added')
    const failure = events.find((event) => event.kind === 'execution.failed')
    expect(failure.seq).toBe(code.seq)
  })

  it('gives the same history the same ids, so citations keep pointing at the right events', async () => {
    await aDesignSession()
    const first = await buildSessionTimeline(ROOM)
    resetTimelineCache()
    const second = await buildSessionTimeline(ROOM)

    expect(second.events.map((event) => event.id + event.text)).toEqual(
      first.events.map((event) => event.id + event.text)
    )
  })

  it('reports problems still standing at the end of the session', async () => {
    await record([{ at: 0, apply: draw(box('Cache', 0, 0)) }])
    const { events } = await buildSessionTimeline(ROOM)

    const warning = events.find((event) => event.kind === 'state.warning')
    expect(warning.text).toMatch(/Cache/)
    expect(warning.detail).toBe('still true at the end of the session')
  })

  /** "Unnamed rect added" tells nobody anything; the parser already warns about it. */
  it('leaves a box nobody labelled out of the architecture, and still notes the drawing', async () => {
    await record([{ at: 0, apply: draw(box(null, 0, 0)) }])
    const { events } = await buildSessionTimeline(ROOM)

    expect(events.some((event) => event.kind === 'architecture.added')).toBe(false)
    expect(events.find((event) => event.kind === 'board.changed').text).toBe('Whiteboard drawn on (+1 shapes)')
  })
})

describe('pieces of work', () => {
  it('starts a new one at a pause or a change of author, and not otherwise', async () => {
    await record([
      { at: 0, actor: ADA, apply: type('a') },
      { at: 10 * 1000, actor: ADA, apply: type('b', 1) },
      { at: 20 * 1000, actor: BO, apply: type('c', 2) },
      { at: 20 * 1000 + SEGMENT_GAP_MS + 1, actor: BO, apply: type('d', 3) },
    ])

    const { segments } = await buildSessionTimeline(ROOM)
    expect(segments).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 3 },
      { from: 4, to: 4 },
    ])
  })
})

describe('building it cheaply', () => {
  it('answers from memory until something it was built from changes', async () => {
    await record([{ at: 0, apply: draw(box('API', 0, 0)) }])

    const first = await buildSessionTimeline(ROOM)
    expect(await buildSessionTimeline(ROOM)).toBe(first)

    // A run is not in the update log, but it is in the timeline, so it has to
    // move the signature too.
    await run({ at: MIN, state: 'completed' })
    const after = await buildSessionTimeline(ROOM)

    expect(after).not.toBe(first)
    expect(after.events.some((event) => event.kind === 'execution.succeeded')).toBe(true)
  })

  it('returns an empty timeline for a room with no history, rather than failing', async () => {
    const { events, throughSeq } = await buildSessionTimeline('nobody-here')
    expect(events).toEqual([])
    expect(throughSeq).toBe(0)
  })
})

describe('one moment', () => {
  it('says exactly what changed at a point, lines included', async () => {
    await record([
      { at: 0, apply: draw(box('API', 0, 0)) },
      { at: 5 * MIN, apply: type('function login(user) {\n  return true\n}\n') },
    ])
    const timeline = await buildSessionTimeline(ROOM)

    const moment = await momentAt(ROOM, 2, timeline)
    expect(moment.changes).toEqual(['Code: added login (+3 / -0 lines)'])
    expect(moment.lines.added).toContain('function login(user) {')
    expect(moment.lines.removed).toEqual([])
  })
})

describe('reading code', () => {
  it('finds declarations in every language the editor offers', () => {
    const names = declarationsIn(
      [
        'function login(user) {}',
        'const logout = async (user) => {}',
        'class UserService {}',
        'def charge(card):',
        'public static void main(String[] args) {',
        'func Serve(w http.ResponseWriter) {}',
        'fn parse(input: &str) {}',
      ].join('\n')
    )

    expect([...names].sort()).toEqual(
      ['Serve', 'UserService', 'charge', 'login', 'logout', 'main', 'parse'].sort()
    )
  })

  /** A false declaration puts a function in the summary that nobody wrote. */
  it('does not mistake a call or a condition for a declaration', () => {
    expect([...declarationsIn('if (ready) { check(user); return run(x) }')]).toEqual([])
  })

  it('counts lines added and removed without caring where they went', () => {
    expect(lineDelta('a\nb\nc', 'a\nc\nd\ne')).toEqual({ added: 2, removed: 1 })
    expect(lineDelta('', 'x')).toEqual({ added: 1, removed: 0 })
  })

  it('writes elapsed time the way a timeline reads', () => {
    expect(clockOf(0)).toBe('00:00')
    expect(clockOf(4 * MIN)).toBe('04:00')
    expect(clockOf(62 * MIN + 9000)).toBe('1:02:09')
  })
})
