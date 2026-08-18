import * as Y from 'yjs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { DocUpdate } from '../src/models/DocUpdate.js'
import { listTimeline, snapshotJsonAt, stateAt } from '../src/services/replay.service.js'

const ROOM = 'replay-room'

/** Records each discrete update a document produces, in order. */
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

describe('replay', () => {
  it('rebuilds the exact state at each point in the log', async () => {
    const updates = recordEdits([
      (doc) => doc.getText('code').insert(0, 'hello'),
      (doc) => doc.getArray('shapes').push([{ id: 'a', type: 'rect' }]),
      (doc) => doc.getText('code').insert(5, ' world'),
    ])
    expect(updates).toHaveLength(3)
    await seedLog(updates)

    const first = await snapshotJsonAt(ROOM, 1)
    expect(first.code).toBe('hello')
    expect(first.shapes).toEqual([])

    const second = await snapshotJsonAt(ROOM, 2)
    expect(second.code).toBe('hello')
    expect(second.shapes).toEqual([{ id: 'a', type: 'rect' }])

    const third = await snapshotJsonAt(ROOM, 3)
    expect(third.code).toBe('hello world')
    expect(third.shapes).toEqual([{ id: 'a', type: 'rect' }])
  })

  it('reports how many updates were folded', async () => {
    await seedLog(recordEdits([(doc) => doc.getText('code').insert(0, 'abc')]))
    const { applied, state } = await stateAt(ROOM, 5)
    expect(applied).toBe(1)
    expect(state.byteLength).toBeGreaterThan(0)
  })

  it('returns an empty document for seq 0', async () => {
    await seedLog(recordEdits([(doc) => doc.getText('code').insert(0, 'abc')]))
    expect((await snapshotJsonAt(ROOM, 0)).code).toBe('')
  })

  it('keeps rooms isolated', async () => {
    await seedLog(recordEdits([(doc) => doc.getText('code').insert(0, 'mine')]), ROOM)
    await seedLog(recordEdits([(doc) => doc.getText('code').insert(0, 'theirs')]), 'other-room')

    expect((await snapshotJsonAt(ROOM, 99)).code).toBe('mine')
    expect((await snapshotJsonAt('other-room', 99)).code).toBe('theirs')
  })

  it('rejects a negative seq', async () => {
    await expect(stateAt(ROOM, -1)).rejects.toThrow(/non-negative/)
  })

  it('lists the timeline in order with metadata only', async () => {
    await seedLog(
      recordEdits([
        (doc) => doc.getText('code').insert(0, 'a'),
        (doc) => doc.getText('code').insert(1, 'b'),
      ])
    )

    const timeline = await listTimeline(ROOM)
    expect(timeline.map((entry) => entry.seq)).toEqual([1, 2])
    expect(timeline[0]).toHaveProperty('at')
    expect(timeline[0]).toHaveProperty('size')
    expect(timeline[0]).not.toHaveProperty('update')
  })
})

describe('append-only enforcement', () => {
  beforeEach(async () => {
    await seedLog(recordEdits([(doc) => doc.getText('code').insert(0, 'seed')]))
  })

  it('refuses updateOne', async () => {
    await expect(DocUpdate.updateOne({ roomId: ROOM }, { $set: { seq: 99 } })).rejects.toThrow(
      /append-only/
    )
  })

  it('refuses findOneAndUpdate', async () => {
    await expect(
      DocUpdate.findOneAndUpdate({ roomId: ROOM }, { $set: { seq: 99 } })
    ).rejects.toThrow(/append-only/)
  })

  it('refuses deleteMany', async () => {
    await expect(DocUpdate.deleteMany({ roomId: ROOM })).rejects.toThrow(/append-only/)
  })

  it('refuses re-saving a loaded entry', async () => {
    const entry = await DocUpdate.findOne({ roomId: ROOM })
    entry.actor = 'tampered'
    await expect(entry.save()).rejects.toThrow(/append-only/)
  })

  it('still allows appending', async () => {
    const before = await DocUpdate.countDocuments({ roomId: ROOM })
    await DocUpdate.create({ roomId: ROOM, seq: 500, update: Buffer.from([1, 2, 3]), size: 3 })
    expect(await DocUpdate.countDocuments({ roomId: ROOM })).toBe(before + 1)
  })

  it('refuses a duplicate seq within a room', async () => {
    await expect(
      DocUpdate.create({ roomId: ROOM, seq: 1, update: Buffer.from([9]), size: 1 })
    ).rejects.toThrow()
  })
})
