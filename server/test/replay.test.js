import * as Y from 'yjs'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { DocUpdate } from '../src/models/DocUpdate.js'
import {
  backfillCheckpoints,
  CHECKPOINT_EVERY,
  listTimeline,
  snapshotJsonAt,
  stateAt,
} from '../src/services/replay.service.js'
import { env } from '../src/config/env.js'

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

describe('replay HTTP edge cases', () => {
  let app

  const ALICE = { email: 'alice@replay.test', password: 'correct-horse-battery', name: 'Alice' }
  const BOB = { email: 'bob@replay.test', password: 'another-good-passphrase', name: 'Bob' }

  const register = (who) => request(app).post('/api/v1/auth/register').send(who)
  const auth = (token) => ({ Authorization: 'Bearer ' + token })

  async function makeRoom(token, name = 'Replay Room', isPublic = false) {
    const res = await request(app).post('/api/v1/rooms').set(auth(token)).send({ name, isPublic })
    return res.body.room
  }

  beforeEach(async () => {
    await clearDatabase()
    app = createApp()
  })

  describe('GET /api/v1/rooms/:roomId/replay', () => {
    it('returns empty timeline for a room with no updates', async () => {
      const { body } = await register(ALICE)
      const room = await makeRoom(body.token)

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/replay`)
        .set(auth(body.token))

      expect(res.status).toBe(200)
      expect(res.body.timeline).toEqual([])
    })

    it('returns 404 for a nonexistent room', async () => {
      const { body } = await register(ALICE)
      const res = await request(app)
        .get('/api/v1/rooms/no-such-room/replay')
        .set(auth(body.token))

      expect(res.status).toBe(404)
    })

    /** The scrubber pages with these two, so the route has to honour both. */
    it('pages with limit and from', async () => {
      const { body } = await register(ALICE)
      const room = await makeRoom(body.token)
      await seedLog(
        recordEdits([
          (doc) => doc.getText('code').insert(0, 'a'),
          (doc) => doc.getText('code').insert(1, 'b'),
          (doc) => doc.getText('code').insert(2, 'c'),
        ]),
        room.roomId
      )

      const first = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/replay?limit=2`)
        .set(auth(body.token))
      expect(first.body.timeline.map((entry) => entry.seq)).toEqual([1, 2])

      const next = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/replay?limit=2&from=2`)
        .set(auth(body.token))
      expect(next.body.timeline.map((entry) => entry.seq)).toEqual([3])
    })

    it('denies access to a private room for non-members', async () => {
      const alice = await register(ALICE)
      const bob = await register(BOB)
      const room = await makeRoom(alice.body.token, 'Private')

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/replay`)
        .set(auth(bob.body.token))

      expect(res.status).toBe(403)
    })

    it('allows access to a public room for unauthenticated users', async () => {
      const { body } = await register(ALICE)
      const room = await makeRoom(body.token, 'Public', true)

      const res = await request(app).get(`/api/v1/rooms/${room.roomId}/replay`)

      expect(res.status).toBe(200)
      expect(res.body.timeline).toEqual([])
    })

    it('returns replay_disabled when PERSIST_UPDATE_LOG is false', async () => {
      const original = env.PERSIST_UPDATE_LOG
      env.PERSIST_UPDATE_LOG = false
      try {
        const { body } = await register(ALICE)
        const room = await makeRoom(body.token)

        const res = await request(app)
          .get(`/api/v1/rooms/${room.roomId}/replay`)
          .set(auth(body.token))

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe('replay_disabled')
      } finally {
        env.PERSIST_UPDATE_LOG = original
      }
    })
  })

  describe('GET /api/v1/rooms/:roomId/replay/:seq', () => {
    it('returns 404 for a nonexistent room', async () => {
      const { body } = await register(ALICE)
      const res = await request(app)
        .get('/api/v1/rooms/no-such-room/replay/0')
        .set(auth(body.token))

      expect(res.status).toBe(404)
    })

    it('denies access to a private room for non-members', async () => {
      const alice = await register(ALICE)
      const bob = await register(BOB)
      const room = await makeRoom(alice.body.token, 'Private')

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/replay/0`)
        .set(auth(bob.body.token))

      expect(res.status).toBe(403)
    })

    it('returns 400 for negative seq', async () => {
      const { body } = await register(ALICE)
      const room = await makeRoom(body.token)

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/replay/-1`)
        .set(auth(body.token))

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('bad_seq')
    })

    it('returns 400 for non-numeric seq', async () => {
      const { body } = await register(ALICE)
      const room = await makeRoom(body.token)

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/replay/abc`)
        .set(auth(body.token))

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('bad_seq')
    })

    it('returns 400 for floating point seq', async () => {
      const { body } = await register(ALICE)
      const room = await makeRoom(body.token)

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/replay/1.5`)
        .set(auth(body.token))

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('bad_seq')
    })

    /**
     * The saving has to be visible over HTTP, not just inside the service, or
     * nobody can tell whether a slow replay is folding the whole log again.
     */
    it('answers from a checkpoint and says which one', async () => {
      const { body } = await register(ALICE)
      const room = await makeRoom(body.token)

      const doc = new Y.Doc()
      const updates = []
      doc.on('update', (update) => updates.push(Buffer.from(update)))
      for (let i = 0; i < CHECKPOINT_EVERY; i += 1) doc.getText('code').insert(i, 'x')
      doc.destroy()

      await seedLog(updates, room.roomId)
      await backfillCheckpoints(room.roomId)

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/replay/${CHECKPOINT_EVERY}`)
        .set(auth(body.token))

      expect(res.status).toBe(200)
      const startedFrom = Number(res.headers['x-checkpoint-seq'])
      const folded = Number(res.headers['x-updates-applied'])

      expect(startedFrom).toBeGreaterThan(0)
      expect(folded).toBeLessThan(CHECKPOINT_EVERY)
      // Between them they account for the whole log up to that point.
      expect(startedFrom + folded).toBe(CHECKPOINT_EVERY)
    })

    it('says so plainly when it folded the whole log', async () => {
      const { body } = await register(ALICE)
      const room = await makeRoom(body.token)
      await seedLog(recordEdits([(doc) => doc.getText('code').insert(0, 'short')]), room.roomId)

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/replay/1`)
        .set(auth(body.token))

      expect(res.headers['x-checkpoint-seq']).toBe('0')
      expect(res.headers['x-updates-applied']).toBe('1')
    })

    it('returns an empty state for seq 0 on a room with no updates', async () => {
      const { body } = await register(ALICE)
      const room = await makeRoom(body.token)

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/replay/0`)
        .set(auth(body.token))

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('application/octet-stream')
      expect(Number(res.headers['x-updates-applied'])).toBe(0)
    })

    it('allows access to a public room for unauthenticated users', async () => {
      const { body } = await register(ALICE)
      const room = await makeRoom(body.token, 'Public', true)

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/replay/0`)

      expect(res.status).toBe(200)
    })

    it('returns replay_disabled when PERSIST_UPDATE_LOG is false', async () => {
      const original = env.PERSIST_UPDATE_LOG
      env.PERSIST_UPDATE_LOG = false
      try {
        const { body } = await register(ALICE)
        const room = await makeRoom(body.token)

        const res = await request(app)
          .get(`/api/v1/rooms/${room.roomId}/replay/0`)
          .set(auth(body.token))

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe('replay_disabled')
      } finally {
        env.PERSIST_UPDATE_LOG = original
      }
    })
  })
})
