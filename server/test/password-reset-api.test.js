import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo, waitFor } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { logger } from '../src/config/logger.js'
import { User } from '../src/models/User.js'

/**
 * The reset flow over HTTP, as a browser meets it.
 *
 * The service tests next door prove the token rules. This file is about what
 * the route surface promises: the status codes, the shapes, and above all
 * that a stranger cannot tell a registered address from an unregistered one by
 * anything the response says.
 */

let app
let infoSpy

const ALICE = { email: 'alice@syncspace.test', password: 'correct-horse-battery', name: 'Alice' }
const NEW_PASSWORD = 'an-entirely-new-passphrase'

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
})

const registerAlice = async () => {
  const res = await request(app).post('/api/v1/auth/register').send(ALICE)
  expect(res.status).toBe(201)
  return res.body
}

/** Raw reset tokens handed to delivery, oldest first. */
const loggedResetTokens = () =>
  infoSpy.mock.calls
    .map((call) => String(call[1] ?? ''))
    .filter((message) => message.includes('/reset-password?token='))
    .map((message) => message.match(/token=([0-9a-f]{64})/)[1])

const forgot = (email) => request(app).post('/api/v1/auth/forgot-password').send({ email })

/**
 * Asks for a link and waits for it to actually be issued.
 *
 * The route answers before it looks the address up — that ordering is what
 * stops the response time from revealing whether the address is registered —
 * so the email lands after the response rather than before it. Anything that
 * needs the token has to wait for it instead of reading it straight after.
 */
const forgotAndWait = async (email) => {
  const before = loggedResetTokens().length
  await forgot(email)
  await waitFor(() => loggedResetTokens().length > before, { label: 'the reset email' })
  return loggedResetTokens()
}

/**
 * For the assertions that something did *not* happen. The work outlives the
 * response, so a negative has to be given a moment to not occur; it is a
 * single indexed query against an in-process database, so this is generous.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250))

const reset = (token, password) =>
  request(app).post('/api/v1/auth/reset-password').send({ token, password })

describe('POST /api/v1/auth/forgot-password', () => {
  it('accepts an address that exists and emails exactly one link', async () => {
    await registerAlice()

    const res = await forgot(ALICE.email)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ sent: true })

    await waitFor(() => loggedResetTokens().length === 1, { label: 'the reset email' })
    await settle()
    expect(loggedResetTokens()).toHaveLength(1)
  })

  /**
   * The timing half of not being an oracle.
   *
   * Identical bodies are not enough on their own: looking up a registered
   * address costs a document write that an unregistered one does not, and a
   * response that waits for that work has a duration which carries the answer
   * the body refuses to give.
   *
   * This holds the lookup open and checks the answer arrives anyway. If the
   * route ever went back to awaiting the work, the request could not be
   * answered until `release()` — which happens after the assertion — and this
   * test would fail by timing out rather than by passing quietly.
   */
  it('answers before it has looked the address up at all', async () => {
    await registerAlice()

    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    const findOne = vi.spyOn(User, 'findOne').mockImplementationOnce(() => held.then(() => null))

    const res = await forgot(ALICE.email)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ sent: true })
    // Answered while the only address-dependent step is still pending.
    expect(findOne).toHaveBeenCalled()

    release()
  })

  /**
   * The one that matters. Status, headers and body all have to agree for the
   * two cases, or the endpoint tells anyone who asks which addresses have
   * accounts here.
   */
  it('is indistinguishable for a registered and an unregistered address', async () => {
    await registerAlice()

    const known = await forgot(ALICE.email)
    const unknown = await forgot('nobody@syncspace.test')

    expect(unknown.status).toBe(known.status)
    expect(unknown.body).toEqual(known.body)
    expect(unknown.headers['content-type']).toBe(known.headers['content-type'])
  })

  it('sends nothing for an address that never signed up', async () => {
    await forgot('nobody@syncspace.test')

    // The work happens after the response, so give it time to not happen.
    await settle()
    expect(loggedResetTokens()).toHaveLength(0)
    expect(await User.countDocuments({})).toBe(0)
  })

  it('rejects something that is not an email before it reaches the database', async () => {
    const res = await forgot('not-an-address')

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('needs no bearer token', async () => {
    await registerAlice()
    const res = await forgot(ALICE.email)

    expect(res.status).toBe(200)
    expect(res.request.header.Authorization).toBeUndefined()
  })
})

describe('POST /api/v1/auth/reset-password', () => {
  it('completes the flow: forgot → token → reset → sign in with the new password', async () => {
    await registerAlice()
    const [raw] = await forgotAndWait(ALICE.email)

    const res = await reset(raw, NEW_PASSWORD)

    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ email: ALICE.email, emailVerified: true })
    expect(res.body.token).toEqual(expect.any(String))
    expect(res.body.user).not.toHaveProperty('resetTokenHash')
    expect(res.body.user).not.toHaveProperty('passwordHash')

    const signIn = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ALICE.email, password: NEW_PASSWORD })
    expect(signIn.status).toBe(200)
  })

  it('hands back a token that works on an authenticated route', async () => {
    await registerAlice()
    const [raw] = await forgotAndWait(ALICE.email)

    const { body } = await reset(raw, NEW_PASSWORD)
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer ' + body.token)

    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe(ALICE.email)
  })

  it('refuses the old password afterwards', async () => {
    await registerAlice()
    const [raw] = await forgotAndWait(ALICE.email)
    await reset(raw, NEW_PASSWORD)

    const signIn = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: ALICE.email, password: ALICE.password })

    expect(signIn.status).toBe(401)
    expect(signIn.body.error.code).toBe('bad_credentials')
  })

  it('refuses a link that has already been used', async () => {
    await registerAlice()
    const [raw] = await forgotAndWait(ALICE.email)
    await reset(raw, NEW_PASSWORD)

    const again = await reset(raw, 'yet-another-passphrase')

    expect(again.status).toBe(400)
    expect(again.body.error.code).toBe('invalid_token')
  })

  it('refuses an unknown token', async () => {
    await registerAlice()
    const res = await reset('f'.repeat(64), NEW_PASSWORD)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_token')
  })

  it('rejects a malformed token without a database lookup', async () => {
    const res = await reset('not-a-token', NEW_PASSWORD)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
    expect(res.body.error.message).toContain('malformed reset token')
  })

  /** A reset must not be a way around the minimum the sign-up form enforces. */
  it('holds the new password to the same minimum registration does', async () => {
    await registerAlice()
    const [raw] = await forgotAndWait(ALICE.email)

    const res = await reset(raw, 'short')

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')

    // And the link is still good, so a typo does not cost the attempt.
    expect((await reset(raw, NEW_PASSWORD)).status).toBe(200)
  })

  it('confirms an address that had never been verified', async () => {
    await registerAlice()
    expect((await User.findOne({ email: ALICE.email })).emailVerified).toBe(false)

    const [raw] = await forgotAndWait(ALICE.email)
    await reset(raw, NEW_PASSWORD)

    expect((await User.findOne({ email: ALICE.email })).emailVerified).toBe(true)
  })
})
