import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'

let app

const ALICE = { email: 'alice@syncspace.test', password: 'correct-horse-battery', name: 'Alice' }
const BOB = { email: 'bob@syncspace.test', password: 'another-good-passphrase', name: 'Bob' }

const registerUser = (who) => request(app).post('/api/v1/auth/register').send(who)

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  // Rebuilt per test so the rate limiter starts from a clean slate.
  app = createApp()
})

describe('health', () => {
  it('reports a connected database', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'ok', db: 'connected' })
  })
})

describe('auth', () => {
  it('registers a user and returns a token', async () => {
    const res = await registerUser(ALICE)
    expect(res.status).toBe(201)
    expect(res.body.token).toEqual(expect.any(String))
    expect(res.body.user).toMatchObject({ email: ALICE.email, name: 'Alice' })
    expect(res.body.user.passwordHash).toBeUndefined()
  })

  it('refuses a duplicate email', async () => {
    await registerUser(ALICE)
    const res = await registerUser(ALICE)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('email_taken')
  })

  it('rejects a short password', async () => {
    const res = await registerUser({ ...ALICE, password: 'short' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('logs in with correct credentials', async () => {
    await registerUser(ALICE)
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ALICE.email, password: ALICE.password })
    expect(res.status).toBe(200)
    expect(res.body.token).toEqual(expect.any(String))
  })

  it('rejects a wrong password', async () => {
    await registerUser(ALICE)
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ALICE.email, password: 'not-the-password' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('bad_credentials')
  })

  it('rejects an unknown email with the same error as a wrong password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@syncspace.test', password: 'whatever-long-enough' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('bad_credentials')
  })

  it('guards /me behind a token', async () => {
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401)

    const { body } = await registerUser(ALICE)
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer ' + body.token)
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe(ALICE.email)
  })
})

describe('rooms', () => {
  it('requires auth to create a room', async () => {
    expect((await request(app).post('/api/v1/rooms').send({ name: 'Design' })).status).toBe(401)
  })

  it('creates a private room owned by the caller', async () => {
    const { body } = await registerUser(ALICE)
    const res = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + body.token)
      .send({ name: 'Interview loop' })

    expect(res.status).toBe(201)
    expect(res.body.room).toMatchObject({ name: 'Interview loop', isPublic: false })
    expect(res.body.room.roomId).toEqual(expect.any(String))
  })

  it('hides a private room from non-members', async () => {
    const alice = (await registerUser(ALICE)).body
    const bob = (await registerUser(BOB)).body

    const created = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + alice.token)
      .send({ name: 'Private' })

    const roomId = created.body.room.roomId

    const owner = await request(app)
      .get('/api/v1/rooms/' + roomId)
      .set('Authorization', 'Bearer ' + alice.token)
    expect(owner.status).toBe(200)

    const stranger = await request(app)
      .get('/api/v1/rooms/' + roomId)
      .set('Authorization', 'Bearer ' + bob.token)
    expect(stranger.status).toBe(403)
    expect(stranger.body.error.code).toBe('room_forbidden')

    expect((await request(app).get('/api/v1/rooms/' + roomId)).status).toBe(403)
  })

  it('lets an invited member in', async () => {
    const alice = (await registerUser(ALICE)).body
    const bob = (await registerUser(BOB)).body

    const created = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + alice.token)
      .send({ name: 'Shared' })
    const roomId = created.body.room.roomId

    const invite = await request(app)
      .post('/api/v1/rooms/' + roomId + '/invite')
      .set('Authorization', 'Bearer ' + alice.token)
      .send({ userId: bob.user.id })
    expect(invite.status).toBe(200)

    const res = await request(app)
      .get('/api/v1/rooms/' + roomId)
      .set('Authorization', 'Bearer ' + bob.token)
    expect(res.status).toBe(200)
  })

  it('refuses invites from non-owners', async () => {
    const alice = (await registerUser(ALICE)).body
    const bob = (await registerUser(BOB)).body

    const created = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + alice.token)
      .send({ name: 'Shared' })

    const res = await request(app)
      .post('/api/v1/rooms/' + created.body.room.roomId + '/invite')
      .set('Authorization', 'Bearer ' + bob.token)
      .send({ userId: bob.user.id })

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_owner')
  })

  it('404s an unknown room', async () => {
    const res = await request(app).get('/api/v1/rooms/does-not-exist')
    expect(res.status).toBe(404)
  })
})
