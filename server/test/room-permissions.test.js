import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { Room } from '../src/models/Room.js'

let app

const ALICE = { email: 'alice@perm.test', password: 'correct-horse-battery', name: 'Alice' }
const BOB = { email: 'bob@perm.test', password: 'another-good-passphrase', name: 'Bob' }

const register = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
})

async function makeRoom(token, overrides = {}) {
  const res = await request(app)
    .post('/api/v1/rooms')
    .set(auth(token))
    .send({ name: 'Test room', ...overrides })
  return res.body.room
}

describe('GET /api/v1/rooms (list user rooms)', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/rooms')).status).toBe(401)
  })

  it('returns empty array for a user with no rooms', async () => {
    const { body } = await register(ALICE)
    const res = await request(app).get('/api/v1/rooms').set(auth(body.token))
    expect(res.status).toBe(200)
    expect(res.body.rooms).toEqual([])
  })

  it('returns rooms where the user is owner', async () => {
    const { body } = await register(ALICE)
    await makeRoom(body.token, { name: 'My room' })

    const res = await request(app).get('/api/v1/rooms').set(auth(body.token))
    expect(res.status).toBe(200)
    expect(res.body.rooms).toHaveLength(1)
    expect(res.body.rooms[0].name).toBe('My room')
  })

  it('returns rooms where the user is an invited member', async () => {
    const alice = (await register(ALICE)).body
    const bob = (await register(BOB)).body
    const room = await makeRoom(alice.token, { name: 'Shared' })

    await request(app)
      .post('/api/v1/rooms/' + room.roomId + '/invite')
      .set(auth(alice.token))
      .send({ userId: bob.user.id })
      .expect(200)

    const res = await request(app).get('/api/v1/rooms').set(auth(bob.token))
    expect(res.status).toBe(200)
    expect(res.body.rooms).toHaveLength(1)
    expect(res.body.rooms[0].roomId).toBe(room.roomId)
  })

  it('does not return private rooms the user has no access to', async () => {
    const alice = (await register(ALICE)).body
    await makeRoom(alice.token, { name: 'Private' })

    const bob = (await register(BOB)).body
    const res = await request(app).get('/api/v1/rooms').set(auth(bob.token))
    expect(res.body.rooms).toHaveLength(0)
  })
})

describe('GET /api/v1/rooms/:roomId for public rooms', () => {
  it('allows unauthenticated access to a public room', async () => {
    const { body } = await register(ALICE)
    const room = await makeRoom(body.token, { isPublic: true })

    const res = await request(app).get('/api/v1/rooms/' + room.roomId)
    expect(res.status).toBe(200)
    expect(res.body.room.roomId).toBe(room.roomId)
  })

  it('denies unauthenticated access to a private room', async () => {
    const { body } = await register(ALICE)
    const room = await makeRoom(body.token, { isPublic: false })

    const res = await request(app).get('/api/v1/rooms/' + room.roomId)
    expect(res.status).toBe(403)
  })

  it('allows an invited member to access a private room', async () => {
    const alice = (await register(ALICE)).body
    const bob = (await register(BOB)).body
    const room = await makeRoom(alice.token, { isPublic: false })

    await request(app)
      .post('/api/v1/rooms/' + room.roomId + '/invite')
      .set(auth(alice.token))
      .send({ userId: bob.user.id })
      .expect(200)

    const res = await request(app).get('/api/v1/rooms/' + room.roomId).set(auth(bob.token))
    expect(res.status).toBe(200)
  })
})

describe('creating a public room via API', () => {
  it('allows isPublic: true in the create payload', async () => {
    const { body } = await register(ALICE)
    const res = await request(app)
      .post('/api/v1/rooms')
      .set(auth(body.token))
      .send({ name: 'Open room', isPublic: true })

    expect(res.status).toBe(201)
    expect(res.body.room.isPublic).toBe(true)
  })
})

describe('invite idempotency', () => {
  it('returns the room when inviting someone who is already a member', async () => {
    const alice = (await register(ALICE)).body
    const bob = (await register(BOB)).body
    const room = await makeRoom(alice.token)

    await request(app)
      .post('/api/v1/rooms/' + room.roomId + '/invite')
      .set(auth(alice.token))
      .send({ userId: bob.user.id })
      .expect(200)

    // Second invite should also succeed (idempotent)
    const res = await request(app)
      .post('/api/v1/rooms/' + room.roomId + '/invite')
      .set(auth(alice.token))
      .send({ userId: bob.user.id })
    expect(res.status).toBe(200)

    // Bob should still appear only once as a member
    const roomDoc = await Room.findOne({ roomId: room.roomId })
    const bobs = roomDoc.members.filter((m) => String(m.user) === bob.user.id)
    expect(bobs).toHaveLength(1)
  })
})

describe('invite validation', () => {
  it('rejects an invalid userId format', async () => {
    const { body } = await register(ALICE)
    const room = await makeRoom(body.token)

    const res = await request(app)
      .post('/api/v1/rooms/' + room.roomId + '/invite')
      .set(auth(body.token))
      .send({ userId: 'not-a-mongo-id' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('rejects an empty body', async () => {
    const { body } = await register(ALICE)
    const room = await makeRoom(body.token)

    const res = await request(app)
      .post('/api/v1/rooms/' + room.roomId + '/invite')
      .set(auth(body.token))
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('rejects an invalid role value', async () => {
    const alice = (await register(ALICE)).body
    const bob = (await register(BOB)).body
    const room = await makeRoom(alice.token)

    const res = await request(app)
      .post('/api/v1/rooms/' + room.roomId + '/invite')
      .set(auth(alice.token))
      .send({ userId: bob.user.id, role: 'admin' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })
})

describe('room name boundaries', () => {
  it('accepts a name at exactly 80 characters', async () => {
    const { body } = await register(ALICE)
    const name = 'a'.repeat(80)
    const res = await request(app)
      .post('/api/v1/rooms')
      .set(auth(body.token))
      .send({ name })
    expect(res.status).toBe(201)
    expect(res.body.room.name).toBe(name)
  })

  it('rejects a name longer than 80 characters', async () => {
    const { body } = await register(ALICE)
    const res = await request(app)
      .post('/api/v1/rooms')
      .set(auth(body.token))
      .send({ name: 'a'.repeat(81) })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('trims whitespace and rejects an empty name on update', async () => {
    const { body } = await register(ALICE)
    const room = await makeRoom(body.token, { name: 'Original' })

    const res = await request(app)
      .patch('/api/v1/rooms/' + room.roomId)
      .set(auth(body.token))
      .send({ name: '   ' })
    expect(res.status).toBe(400)
  })
})

describe('room toPublic shape', () => {
  it('includes memberCount and owner fields', async () => {
    const { body } = await register(ALICE)
    const room = await makeRoom(body.token, { name: 'Shape check' })

    const res = await request(app).get('/api/v1/rooms/' + room.roomId).set(auth(body.token))
    expect(res.body.room).toMatchObject({
      roomId: expect.any(String),
      name: 'Shape check',
      isPublic: false,
      owner: expect.any(String),
      memberCount: 1,
      lastActivityAt: expect.any(String),
    })
  })
})
