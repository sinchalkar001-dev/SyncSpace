import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { logger } from '../src/config/logger.js'
import { User } from '../src/models/User.js'

let app
let infoSpy

const ALICE = { email: 'alice@syncspace.test', password: 'correct-horse-battery', name: 'Alice' }

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
  // Outside production the confirm link is logged, so tests read the token
  // from the same place a real mailer would take it from.
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
})

const register = async (who = ALICE) => {
  const res = await request(app).post('/api/v1/auth/register').send(who)
  expect(res.status).toBe(201)
  return res.body
}

/** Raw tokens handed to delivery, oldest first. */
const loggedTokens = () =>
  infoSpy.mock.calls
    .map((call) => String(call[1] ?? ''))
    .filter((message) => message.includes('/api/v1/auth/verify-email?token='))
    .map((message) => message.split('token=')[1])

describe('POST /api/v1/auth/verify-email', () => {
  it('registration issues exactly one pending, hashed, unexpired token', async () => {
    await register()

    const user = await User.findOne({ email: ALICE.email })
    expect(user.emailVerified).toBe(false)
    expect(user.verificationTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(user.verificationTokenExpiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(loggedTokens()).toHaveLength(1)
  })

  it('completes the flow: register → token → verify → verified on /me', async () => {
    const { token } = await register()
    const [raw] = loggedTokens()

    const res = await request(app).post('/api/v1/auth/verify-email').send({ token: raw })

    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ email: ALICE.email, emailVerified: true })
    expect(res.body.user).not.toHaveProperty('verificationTokenHash')

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer ' + token)
    expect(me.status).toBe(200)
    expect(me.body.user.emailVerified).toBe(true)
  })

  it('rejects an unknown well-formed token', async () => {
    await register()

    const res = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'a'.repeat(64) })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_token')
  })

  it('rejects a malformed body before touching the database', async () => {
    await register()

    for (const body of [{}, { token: 'short' }, { token: 'z'.repeat(64) }, { token: 42 }]) {
      const res = await request(app).post('/api/v1/auth/verify-email').send(body)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('validation_failed')
    }
  })

  it('rejects an expired token and leaves the account unverified', async () => {
    await register()
    const user = await User.findOne({ email: ALICE.email })
    await User.findByIdAndUpdate(user._id, {
      verificationTokenExpiresAt: new Date(Date.now() - 1000),
    })

    const res = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: loggedTokens()[0] })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_token')

    const reloaded = await User.findById(user._id)
    expect(reloaded.emailVerified).toBe(false)
  })

  it('consumes the token so it cannot be replayed', async () => {
    await register()
    const [raw] = loggedTokens()

    const first = await request(app).post('/api/v1/auth/verify-email').send({ token: raw })
    expect(first.status).toBe(200)

    const replay = await request(app).post('/api/v1/auth/verify-email').send({ token: raw })
    expect(replay.status).toBe(400)
    expect(replay.body.error.code).toBe('invalid_token')

    const user = await User.findOne({ email: ALICE.email })
    expect(user.verificationTokenHash).toBeNull()
    expect(user.emailVerifiedAt).toBeInstanceOf(Date)
  })
})

describe('POST /api/v1/auth/resend-verification', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/auth/resend-verification')
    expect(res.status).toBe(401)
  })

  it('re-issues a working token and invalidates the previous one', async () => {
    const { token } = await register()
    const [first] = loggedTokens()

    const res = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', 'Bearer ' + token)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ sent: true })
    expect(loggedTokens()).toHaveLength(2)

    const stale = await request(app).post('/api/v1/auth/verify-email').send({ token: first })
    expect(stale.status).toBe(400)

    const [, second] = loggedTokens()
    const fresh = await request(app).post('/api/v1/auth/verify-email').send({ token: second })
    expect(fresh.status).toBe(200)
    expect(fresh.body.user.emailVerified).toBe(true)
  })

  it('refuses an already-verified account', async () => {
    const { token } = await register()
    await request(app).post('/api/v1/auth/verify-email').send({ token: loggedTokens()[0] })

    const res = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', 'Bearer ' + token)

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('already_verified')
    expect(loggedTokens()).toHaveLength(1)
  })
})
