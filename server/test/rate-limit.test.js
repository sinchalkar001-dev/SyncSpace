import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { env } from '../src/config/env.js'

let app

const ALICE = { email: 'alice@syncspace.test', password: 'correct-horse-battery', name: 'Alice' }

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  // Rebuilt per test so every limiter starts from an empty store.
  app = createApp()
})

const register = (who) => request(app).post('/api/v1/auth/register').send(who)

describe('rate limiting', () => {
  it('cuts off registration after its own budget', async () => {
    for (let i = 0; i < env.AUTH_RATE_LIMIT_REGISTER_MAX; i += 1) {
      const res = await register({
        email: `user-${i}@syncspace.test`,
        password: 'a-good-passphrase',
      })
      expect(res.status).toBe(201)
    }

    const res = await register({
      email: 'one-too-many@syncspace.test',
      password: 'a-good-passphrase',
    })
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('rate_limited')
    expect(res.headers['ratelimit-limit']).toBeDefined()
  })

  it('limits login attempts separately from registration', async () => {
    await register(ALICE)

    for (let i = 0; i < env.AUTH_RATE_LIMIT_LOGIN_MAX; i += 1) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: ALICE.email, password: 'not-the-password' })
      expect(res.status).toBe(401)
    }

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ALICE.email, password: ALICE.password })
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('rate_limited')
  })

  it('limits password changes without touching other endpoints', async () => {
    const { body } = await register(ALICE)

    for (let i = 0; i < env.AUTH_RATE_LIMIT_PASSWORD_CHANGE_MAX; i += 1) {
      const res = await request(app)
        .post('/api/v1/auth/change-password')
        .set('Authorization', 'Bearer ' + body.token)
        .send({ currentPassword: 'wrong-password', newPassword: 'brand-new-password' })
      expect(res.status).toBe(401)
    }

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', 'Bearer ' + body.token)
      .send({ currentPassword: ALICE.password, newPassword: 'brand-new-password' })
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('rate_limited')

    // The exhausted password budget must not bleed into everyday calls.
    const rooms = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + body.token)
    expect(rooms.status).toBe(200)
  })

  it('limits verification attempts without touching other endpoints', async () => {
    await register(ALICE)
    const bad = { token: 'b'.repeat(64) } // well-formed, so it reaches the limiter

    for (let i = 0; i < env.AUTH_RATE_LIMIT_VERIFY_MAX; i += 1) {
      const res = await request(app).post('/api/v1/auth/verify-email').send(bad)
      expect(res.status).toBe(400)
    }

    const res = await request(app).post('/api/v1/auth/verify-email').send(bad)
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('rate_limited')

    // The exhausted verify budget must not bleed into everyday calls.
    const carol = await register({ email: 'carol@syncspace.test', password: 'a-good-passphrase' })
    const rooms = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + carol.body.token)
    expect(rooms.status).toBe(200)
  })

  it('limits resend requests separately from login and registration', async () => {
    const { body } = await register(ALICE)

    for (let i = 0; i < env.AUTH_RATE_LIMIT_RESEND_MAX; i += 1) {
      const res = await request(app)
        .post('/api/v1/auth/resend-verification')
        .set('Authorization', 'Bearer ' + body.token)
      expect(res.status).toBe(200)
    }

    const res = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', 'Bearer ' + body.token)
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('rate_limited')

    // Login still works on its own budget.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ALICE.email, password: ALICE.password })
    expect(login.status).toBe(200)
  })

  it('keeps normal room operations well under their budget', async () => {
    const { body } = await register(ALICE)
    const auth = { Authorization: 'Bearer ' + body.token }

    // Far more calls than any credential budget allows, all served normally.
    for (let i = 0; i < 12; i += 1) {
      const created = await request(app).post('/api/v1/rooms').set(auth).send({ name: 'Room ' + i })
      expect(created.status).toBe(201)

      const listed = await request(app).get('/api/v1/rooms').set(auth)
      expect(listed.status).toBe(200)
    }
  })

  it('still allows a normal invite flow', async () => {
    const alice = (await register(ALICE)).body
    const bob = (
      await register({ email: 'bob@syncspace.test', password: 'another-good-passphrase' })
    ).body

    const created = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + alice.token)
      .send({ name: 'Shared' })

    const res = await request(app)
      .post('/api/v1/rooms/' + created.body.room.roomId + '/invite')
      .set('Authorization', 'Bearer ' + alice.token)
      .send({ userId: bob.user.id })
    expect(res.status).toBe(200)
  })
})
