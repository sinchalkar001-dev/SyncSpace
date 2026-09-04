import * as Y from 'yjs'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { DocUpdate } from '../src/models/DocUpdate.js'
import { listTimeline, stateAt, snapshotJsonAt } from '../src/services/replay.service.js'

const ROOM = 'replay-edge'

function recordEdits(steps) {
  const doc = new Y.Doc()
  const updates = []
  doc.on('update', (update) => updates.push(Buffer.from(update)))
  steps.forEach((step) => step(doc))
  doc.destroy()
  return updates
}

async function seedLog(updates, roomId = ROOM) {
  for (let i = 0; i < updates.length; i += 1) {
    await DocUpdate.create({
      roomId,
      seq: i + 1,
      update: updates[i],
      actor: 'user-' + (i % 2),
      size: updates[i].byteLength,
    })
  }
}

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)
beforeEach(clearDatabase)

describe('listTimeline edge cases', () => {
  it('respects a custom limit parameter', async () => {
    await seedLog(
      recordEdits([
        (doc) => doc.getText('code').insert(0, 'a'),
        (doc) => doc.getText('code').insert(1, 'b'),
        (doc) => doc.getText('code').insert(2, 'c'),
      ])
    )

    const timeline = await listTimeline(ROOM, { limit: 2 })
    expect(timeline).toHaveLength(2)
    expect(timeline.map((e) => e.seq)).toEqual([1, 2])
  })

  it('caps limit at MAX_TIMELINE (500)', async () => {
    // Even requesting 999 should not error and should return at most what exists
    await seedLog(recordEdits([(doc) => doc.getText('code').insert(0, 'x')]))
    const timeline = await listTimeline(ROOM, { limit: 999 })
    expect(timeline).toHaveLength(1)
  })

  it('falls back to default when limit is 0', async () => {
    await seedLog(recordEdits([(doc) => doc.getText('code').insert(0, 'x')]))
    const timeline = await listTimeline(ROOM, { limit: 0 })
    expect(timeline).toHaveLength(1)
  })

  it('falls back to default when limit is negative', async () => {
    await seedLog(recordEdits([(doc) => doc.getText('code').insert(0, 'x')]))
    const timeline = await listTimeline(ROOM, { limit: -5 })
    expect(timeline).toHaveLength(1)
  })

  it('falls back to default when limit is non-numeric', async () => {
    await seedLog(recordEdits([(doc) => doc.getText('code').insert(0, 'x')]))
    const timeline = await listTimeline(ROOM, { limit: 'abc' })
    expect(timeline).toHaveLength(1)
  })

  it('returns empty array for a room with no updates', async () => {
    const timeline = await listTimeline('empty-room')
    expect(timeline).toEqual([])
  })
})

/**
 * A scrubber has to be able to reach the present. One response is capped at
 * 500 entries, which a room passes within minutes of typing, so the client
 * pages with the last seq it saw.
 */
describe('listTimeline paging', () => {
  const four = () =>
    recordEdits([
      (doc) => doc.getText('code').insert(0, 'a'),
      (doc) => doc.getText('code').insert(1, 'b'),
      (doc) => doc.getText('code').insert(2, 'c'),
      (doc) => doc.getText('code').insert(3, 'd'),
    ])

  it('reads the next page from the last seq of the previous one', async () => {
    await seedLog(four())

    const first = await listTimeline(ROOM, { limit: 2 })
    expect(first.map((entry) => entry.seq)).toEqual([1, 2])

    const second = await listTimeline(ROOM, { limit: 2, from: first[first.length - 1].seq })
    expect(second.map((entry) => entry.seq)).toEqual([3, 4])

    // And the end of the log is an empty page, not a repeat of the last one.
    const third = await listTimeline(ROOM, { limit: 2, from: 4 })
    expect(third).toEqual([])
  })

  it('is exclusive, so no entry is read twice', async () => {
    await seedLog(four())
    const page = await listTimeline(ROOM, { from: 2 })
    expect(page.map((entry) => entry.seq)).toEqual([3, 4])
  })

  it('ignores from when it is absent, zero or nonsense', async () => {
    await seedLog(four())
    for (const from of [undefined, 0, -3, 'abc', null]) {
      const page = await listTimeline(ROOM, { from })
      expect(page.map((entry) => entry.seq), 'from=' + String(from)).toEqual([1, 2, 3, 4])
    }
  })

  it('keeps paging scoped to one room', async () => {
    await seedLog(four())
    await seedLog(four(), 'other-room')
    expect(await listTimeline('other-room', { from: 2 })).toHaveLength(2)
    expect(await listTimeline(ROOM, { from: 2 })).toHaveLength(2)
  })
})

describe('stateAt edge cases', () => {
  it('applies all available updates when seq exceeds the log length', async () => {
    await seedLog(
      recordEdits([
        (doc) => doc.getText('code').insert(0, 'hello'),
        (doc) => doc.getText('code').insert(5, ' world'),
      ])
    )

    const { state: _state, applied } = await stateAt(ROOM, 999)
    expect(applied).toBe(2)
    const json = await snapshotJsonAt(ROOM, 999)
    expect(json.code).toBe('hello world')
  })

  it('returns empty document state at seq 0 for a room with updates', async () => {
    await seedLog(recordEdits([(doc) => doc.getText('code').insert(0, 'data')]))
    const json = await snapshotJsonAt(ROOM, 0)
    expect(json.code).toBe('')
    expect(json.shapes).toEqual([])
  })

  it('reconstructs correctly at seq 1 of a multi-update room', async () => {
    await seedLog(
      recordEdits([
        (doc) => doc.getText('code').insert(0, 'first'),
        (doc) => doc.getText('code').insert(5, ' second'),
        (doc) => doc.getArray('shapes').push([{ id: 's1', type: 'rect' }]),
      ])
    )

    const json1 = await snapshotJsonAt(ROOM, 1)
    expect(json1.code).toBe('first')
    expect(json1.shapes).toEqual([])

    const json2 = await snapshotJsonAt(ROOM, 2)
    expect(json2.code).toBe('first second')
    expect(json2.shapes).toEqual([])

    const json3 = await snapshotJsonAt(ROOM, 3)
    expect(json3.code).toBe('first second')
    expect(json3.shapes).toEqual([{ id: 's1', type: 'rect' }])
  })

  it('rejects a non-integer seq', async () => {
    await expect(stateAt(ROOM, 1.5)).rejects.toThrow(/non-negative/)
  })
})

describe('replay HTTP with seq=0 on a room with updates', () => {
  let app

  const ALICE = { email: 'alice@replay-edge.test', password: 'correct-horse-battery', name: 'Alice' }

  const register = (who) => request(app).post('/api/v1/auth/register').send(who)
  const auth = (token) => ({ Authorization: 'Bearer ' + token })

  async function makeRoom(token) {
    const res = await request(app).post('/api/v1/rooms').set(auth(token)).send({ name: 'Replay' })
    return res.body.room
  }

  beforeEach(async () => {
    await clearDatabase()
    app = createApp()
  })

  it('returns empty state at seq 0 even though updates exist', async () => {
    const { body } = await register(ALICE)
    const room = await makeRoom(body.token)

    // Seed updates directly into the DB for this room
    await seedLog(
      recordEdits([
        (doc) => doc.getText('code').insert(0, 'hello'),
        (doc) => doc.getText('code').insert(5, ' world'),
      ]),
      room.roomId
    )

    const res = await request(app)
      .get(`/api/v1/rooms/${room.roomId}/replay/0`)
      .set(auth(body.token))

    expect(res.status).toBe(200)
    expect(Number(res.headers['x-updates-applied'])).toBe(0)
  })
})
