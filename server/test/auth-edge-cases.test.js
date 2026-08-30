import request from 'supertest'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { User } from '../src/models/User.js'

let app

const ALICE = { email: 'alice@edge.test', password: 'correct-horse-battery', name: 'Alice' }

const register = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
})

describe('expired JWT token', () => {
  it('returns 401 when the token has expired', async () => {
    const expired = jwt.sign(
      { sub: '507f1f77bcf86cd799439011', name: 'Ghost' },
      'syncspace-development-secret-do-not-use-in-production',
      { expiresIn: '-1s' }
    )

    const res = await request(app).get('/api/v1/auth/me').set(auth(expired))
    expect(res.status).toBe(401)
  })
})

describe('malformed Authorization headers', () => {
  it('rejects a non-Bearer scheme', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
    expect(res.status).toBe(401)
  })

  it('rejects a garbage token after Bearer', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer not-a-jwt')
    expect(res.status).toBe(401)
  })

  it('rejects an empty Bearer value', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer ')
    expect(res.status).toBe(401)
  })

  it('rejects a Bearer with only whitespace', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer   ')
    expect(res.status).toBe(401)
  })

  it('rejects a token signed with a wrong secret', async () => {
    const wrong = jwt.sign(
      { sub: '507f1f77bcf86cd799439011', name: 'Intruder' },
      'completely-wrong-secret-key-that-is-long-enough',
      { expiresIn: '1h' }
    )
    const res = await request(app).get('/api/v1/auth/me').set(auth(wrong))
    expect(res.status).toBe(401)
  })
})

describe('/me for deleted user', () => {
  it('returns 404 when the user no longer exists', async () => {
    const { body } = await register(ALICE)

    // Delete the user behind the token's back
    await User.deleteMany({ email: ALICE.email })

    const res = await request(app).get('/api/v1/auth/me').set(auth(body.token))
    expect(res.status).toBe(404)
  })
})

describe('registration validation', () => {
  it('rejects missing email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ password: 'valid-password-long', name: 'X' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('rejects missing password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'no-pass@test.com', name: 'X' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('rejects an invalid email format', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: 'valid-password-long' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('rejects an empty body', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('rejects a password shorter than 8 characters', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'short@test.com', password: '1234567' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('uses the email prefix as name when name is omitted', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'customname@test.com', password: 'valid-password-long' })
    expect(res.status).toBe(201)
    expect(res.body.user.name).toBe('customname')
  })
})

describe('login validation', () => {
  it('rejects missing email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: 'valid-password-long' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('rejects missing password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'no-pass@test.com' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('rejects an empty body', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })
})

describe('token not leaked in error responses', () => {
  it('does not include JWT internals in 401 body', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer garbage')
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('jwt')
    expect(body).not.toContain('secret')
    expect(body).not.toContain('expired')
  })
})
