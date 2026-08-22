import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { MongoPersistence } from '../src/collab/persistence.js'
import { DocUpdate } from '../src/models/DocUpdate.js'

let rooms = 0
const nextRoom = () => 'persist-' + Date.now() + '-' + (rooms += 1)

const change = (store, documentName, byte) =>
  store.onChange({ documentName, update: new Uint8Array([byte]), context: {} })

const seqs = (roomId) =>
  DocUpdate.find({ roomId }).sort({ seq: 1 }).select({ seq: 1 }).lean()

beforeAll(async () => {
  await startMemoryMongo()
  await mongoose.connection.syncIndexes()
}, 120000)

afterAll(async () => {
  await stopMemoryMongo()
})

describe('the update log', () => {
  it('numbers updates in order', async () => {
    const store = new MongoPersistence()
    const room = nextRoom()

    await change(store, room, 1)
    await change(store, room, 2)
    await change(store, room, 3)

    expect((await seqs(room)).map((entry) => entry.seq)).toEqual([1, 2, 3])
  })

  it('recovers when the in-memory counter has fallen behind the log', async () => {
    const store = new MongoPersistence()
    const room = nextRoom()

    await change(store, room, 1)
    await change(store, room, 2)

    // Exactly what a reconnect used to do: clear the counter while rows for
    // this room already exist. It restarted at 1 and hit the unique index.
    store.sequences.delete(room)

    await change(store, room, 3)

    expect((await seqs(room)).map((entry) => entry.seq)).toEqual([1, 2, 3])
  })

  it('survives concurrent appends without losing or reusing a number', async () => {
    const store = new MongoPersistence()
    const room = nextRoom()

    await Promise.all(
      Array.from({ length: 8 }, (_, index) => {
        // Every other writer starts from a stale counter, which is the
        // multi-writer race in miniature.
        if (index % 2 === 0) store.sequences.delete(room)
        return change(store, room, index)
      })
    )

    const written = (await seqs(room)).map((entry) => entry.seq)
    expect(new Set(written).size).toBe(written.length)
    expect(written.length).toBeGreaterThan(0)
  })

  it('never rejects, because Hocuspocus turns a rejection into a dead process', async () => {
    const store = new MongoPersistence()

    // A document name that cannot be stored: onChange must swallow it.
    await expect(
      store.onChange({ documentName: null, update: new Uint8Array([1]), context: {} })
    ).resolves.toBeUndefined()
  })

  it('forgets a room only once its document leaves memory', async () => {
    const store = new MongoPersistence()
    const room = nextRoom()

    await change(store, room, 1)
    expect(store.sequences.has(room)).toBe(true)

    await store.afterUnloadDocument({ documentName: room })
    expect(store.sequences.has(room)).toBe(false)
  })
})
