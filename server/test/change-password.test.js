import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'

let app

const ALICE = { email: 'alice@syncspace.test', password: 'correct-horse-battery', name: 'Alice' }

const registerUser = (who) => request(app).post('/api/v1/auth/register').send(who)

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
})

describe('POST /api/v1/auth/change-password', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'anything', newPassword: 'new-valid-password' })
    expect(res.status).toBe(401)
  })

  it('changes the password with valid current password', async () => {
    const { body } = await registerUser(ALICE)
    const token = body.token

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', 'Bearer ' + token)
      .send({ currentPassword: ALICE.password, newPassword: 'brand-new-password' })

    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ email: ALICE.email, name: ALICE.name })

    // Old password no longer works
    const oldLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ALICE.email, password: ALICE.password })
    expect(oldLogin.status).toBe(401)

    // New password works
    const newLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ALICE.email, password: 'brand-new-password' })
    expect(newLogin.status).toBe(200)
    expect(newLogin.body.token).toEqual(expect.any(String))
  })

  it('rejects an incorrect current password', async () => {
    const { body } = await registerUser(ALICE)

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', 'Bearer ' + body.token)
      .send({ currentPassword: 'wrong-password-here', newPassword: 'brand-new-password' })

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('bad_password')

    // Original password still works
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ALICE.email, password: ALICE.password })
    expect(login.status).toBe(200)
  })

  it('rejects a new password that is too short', async () => {
    const { body } = await registerUser(ALICE)

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', 'Bearer ' + body.token)
      .send({ currentPassword: ALICE.password, newPassword: 'short' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('rejects missing fields', async () => {
    const { body } = await registerUser(ALICE)

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', 'Bearer ' + body.token)
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })
})
