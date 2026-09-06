import request from 'supertest'
import { io as ioClient } from 'socket.io-client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { startServer } from '../src/index.js'
import { Session } from '../src/models/Session.js'
import { login, register } from '../src/services/auth.service.js'

/**
 * Seeing what is signed in, and signing one of it out.
 *
 * Revoking used to be all-or-nothing: a single marker on the account could end
 * every session at once but could not name them, so there was no way to answer
 * "what is signed in?" or "sign out that one". A row per session answers both.
 *
 * The property worth guarding hardest is the boring one — that these endpoints
 * reach the caller's own sessions and nothing else. An id is the only thing
 * they take, and ids are handed out in the list, so a mistake here would let
 * anyone sign anyone else out.
 */

let server
let base

const ALICE = { email: 'alice@syncspace.test', password: 'correct-horse-battery', name: 'Alice' }
const BOB = { email: 'bob@syncspace.test', password: 'a-different-passphrase', name: 'Bob' }

beforeAll(async () => {
  await startMemoryMongo()
  server = await startServer({ port: 0, host: '127.0.0.1', connectDb: false })
  base = 'http://127.0.0.1:' + server.port
}, 120000)

afterAll(async () => {
  await server.close()
  await stopMemoryMongo()
})

beforeEach(clearDatabase)

const authed = (method, path, token) =>
  request(base)[method](path).set('Authorization', 'Bearer ' + token)

const sessions = (token) => authed('get', '/api/v1/auth/sessions', token)
const signOutOne = (token, id) => authed('delete', '/api/v1/auth/sessions/' + id, token)
const signOutOthers = (token) => authed('delete', '/api/v1/auth/sessions', token)
const me = (token) => authed('get', '/api/v1/auth/me', token)

/** Signs in again, which is a second device as far as the list is concerned. */
const anotherDevice = async (who = ALICE) =>
  (await login({ email: who.email, password: who.password })).token

describe('GET /api/v1/auth/sessions', () => {
  it('needs a token', async () => {
    expect((await request(base).get('/api/v1/auth/sessions')).status).toBe(401)
  })

  it('lists the session that signing up created', async () => {
    const { token } = await register(ALICE)

    const res = await sessions(token)

    expect(res.status).toBe(200)
    expect(res.body.sessions).toHaveLength(1)
    expect(res.body.sessions[0]).toMatchObject({ current: true })
    expect(res.body.sessions[0].id).toEqual(expect.any(String))
  })

  it('grows by one for each sign-in', async () => {
    const { token } = await register(ALICE)
    await anotherDevice()
    await anotherDevice()

    const res = await sessions(token)

    expect(res.body.sessions).toHaveLength(3)
  })

  /**
   * Without this the list is a row of indistinguishable browsers, and the
   * obvious way to work out which one is yours is to sign one out and see.
   */
  it('marks exactly one session as the current one, and it is the caller', async () => {
    const { token } = await register(ALICE)
    const second = await anotherDevice()

    const mine = await sessions(token)
    const theirs = await sessions(second)

    expect(mine.body.sessions.filter((s) => s.current)).toHaveLength(1)
    expect(theirs.body.sessions.filter((s) => s.current)).toHaveLength(1)

    const currentOf = (res) => res.body.sessions.find((s) => s.current).id
    expect(currentOf(mine)).not.toBe(currentOf(theirs))
  })

  it('records what the device called itself and where it came from', async () => {
    await register(ALICE)

    const signIn = await request(base)
      .post('/api/v1/auth/login')
      .set('User-Agent', 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36')
      .send({ email: ALICE.email, password: ALICE.password })

    const res = await sessions(signIn.body.token)
    const current = res.body.sessions.find((s) => s.current)

    expect(current.userAgent).toContain('Chrome/120')
    expect(current.ip).toEqual(expect.any(String))
    expect(current.lastSeenAt).toEqual(expect.any(String))
    expect(current.createdAt).toEqual(expect.any(String))
  })

  it('shows nobody else the sessions on their account', async () => {
    await register(ALICE)
    const bob = await register(BOB)
    await anotherDevice(ALICE)

    const res = await sessions(bob.token)

    expect(res.body.sessions).toHaveLength(1)
    expect(res.body.sessions[0].current).toBe(true)
  })

  it('never hands out the jti, which is the part that would be a credential', async () => {
    const { token } = await register(ALICE)

    const res = await sessions(token)

    expect(JSON.stringify(res.body)).not.toContain('jti')
  })
})

describe('DELETE /api/v1/auth/sessions/:sessionId', () => {
  it('ends that session and leaves the others alone', async () => {
    const { token } = await register(ALICE)
    const other = await anotherDevice()

    const list = await sessions(token)
    const target = list.body.sessions.find((s) => !s.current)

    const res = await signOutOne(token, target.id)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ revoked: 1 })
    expect((await me(other)).status).toBe(401)
    expect((await me(token)).status).toBe(200)
  })

  it('can be used to sign out the device you are on', async () => {
    const { token } = await register(ALICE)
    const list = await sessions(token)
    const current = list.body.sessions.find((s) => s.current)

    expect((await signOutOne(token, current.id)).status).toBe(200)
    expect((await me(token)).status).toBe(401)
  })

  /**
   * The one that would matter most if it were wrong. Ids come from a list
   * anyone can read for their own account, so a missing ownership check would
   * let anybody sign anybody out with a guessable-shaped value.
   */
  it('refuses to touch a session belonging to somebody else', async () => {
    const alice = await register(ALICE)
    const bob = await register(BOB)

    const hers = (await sessions(alice.token)).body.sessions[0]

    const res = await signOutOne(bob.token, hers.id)

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('session_not_found')
    // And hers still works, so the refusal was real rather than cosmetic.
    expect((await me(alice.token)).status).toBe(200)
  })

  it('answers the same 404 for an id that never existed', async () => {
    const { token } = await register(ALICE)

    const res = await signOutOne(token, '507f1f77bcf86cd799439011')

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('session_not_found')
  })

  it('rejects something that is not an id', async () => {
    const { token } = await register(ALICE)

    const res = await signOutOne(token, 'not-an-id')

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_session_id')
  })

  it('needs a token', async () => {
    const { token } = await register(ALICE)
    const list = await sessions(token)

    const res = await request(base).delete('/api/v1/auth/sessions/' + list.body.sessions[0].id)

    expect(res.status).toBe(401)
    expect((await me(token)).status).toBe(200)
  })
})

describe('DELETE /api/v1/auth/sessions', () => {
  it('ends every other session and keeps this one', async () => {
    const { token } = await register(ALICE)
    const second = await anotherDevice()
    const third = await anotherDevice()

    const res = await signOutOthers(token)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ revoked: 2 })
    expect((await me(second)).status).toBe(401)
    expect((await me(third)).status).toBe(401)
    expect((await me(token)).status).toBe(200)

    const left = await sessions(token)
    expect(left.body.sessions).toHaveLength(1)
    expect(left.body.sessions[0].current).toBe(true)
  })

  it('is content when there is nothing else signed in', async () => {
    const { token } = await register(ALICE)

    const res = await signOutOthers(token)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ revoked: 0 })
    expect((await me(token)).status).toBe(200)
  })

  it('leaves other accounts entirely alone', async () => {
    const alice = await register(ALICE)
    const bob = await register(BOB)
    const bobsSecond = await anotherDevice(BOB)
    await anotherDevice(ALICE)

    await signOutOthers(alice.token)

    expect((await me(bob.token)).status).toBe(200)
    expect((await me(bobsSecond)).status).toBe(200)
  })
})

describe('a password change still ends everything', () => {
  it('replaces every session with exactly one', async () => {
    const { token } = await register(ALICE)
    await anotherDevice()
    await anotherDevice()
    expect((await sessions(token)).body.sessions).toHaveLength(3)

    const changed = await request(base)
      .post('/api/v1/auth/change-password')
      .set('Authorization', 'Bearer ' + token)
      .send({ currentPassword: ALICE.password, newPassword: 'an-entirely-new-passphrase' })

    expect(changed.status).toBe(200)

    const left = await sessions(changed.body.token)
    expect(left.body.sessions).toHaveLength(1)
    expect(left.body.sessions[0].current).toBe(true)
  })

  it('leaves no orphaned rows behind', async () => {
    const { token } = await register(ALICE)
    await anotherDevice()

    await request(base)
      .post('/api/v1/auth/change-password')
      .set('Authorization', 'Bearer ' + token)
      .send({ currentPassword: ALICE.password, newPassword: 'an-entirely-new-passphrase' })

    expect(await Session.countDocuments({})).toBe(1)
  })
})

describe('live connections follow the session that owns them', () => {
  const connectSocket = (auth = {}) =>
    ioClient(base, { path: '/socket.io', transports: ['websocket'], auth, reconnection: false })

  const connected = (socket) =>
    new Promise((resolve, reject) => {
      socket.on('connect', () => resolve(socket))
      socket.on('connect_error', reject)
    })

  /**
   * Signing out one device has to reach that device's open connections and no
   * others. Getting this wrong in the generous direction would hang up every
   * tab the account has open; getting it wrong in the mean direction would
   * leave the signed-out device typing on the whiteboard.
   */
  it('closes only the signed-out device connection', async () => {
    const { token } = await register(ALICE)
    const other = await anotherDevice()

    const mine = connectSocket({ token })
    const theirs = connectSocket({ token: other })
    await Promise.all([connected(mine), connected(theirs)])

    let mineEnded = false
    mine.on('session:ended', () => {
      mineEnded = true
    })
    const otherEnded = new Promise((resolve) => theirs.on('session:ended', resolve))

    const list = await sessions(token)
    const target = list.body.sessions.find((s) => !s.current)
    await signOutOne(token, target.id)

    expect(await otherEnded).toMatchObject({ reason: 'signed_out' })
    expect(mineEnded).toBe(false)
    expect(mine.connected).toBe(true)

    mine.disconnect()
    theirs.disconnect()
  })

  it('refuses a socket handshake from a session that has been signed out', async () => {
    const { token } = await register(ALICE)
    const other = await anotherDevice()

    const list = await sessions(token)
    const target = list.body.sessions.find((s) => !s.current)
    await signOutOne(token, target.id)

    const refused = connectSocket({ token: other })
    await expect(connected(refused)).rejects.toThrow(/session ended/i)
    refused.disconnect()
  })
})

describe('one row per token', () => {
  /**
   * `jti` is what every authenticated request looks a session up by, so two
   * rows carrying the same one would make "which session is this?" ambiguous.
   * That uniqueness used to be declared twice — on the field and on the index —
   * which Mongoose reports as a duplicate and builds once regardless. Only the
   * index says it now, so this guards the constraint rather than the line that
   * happens to spell it out.
   */
  it('refuses a second row for the same jti', async () => {
    await Session.init()
    await register(ALICE)
    const existing = await Session.findOne({}).lean()

    await expect(
      Session.create({ user: existing.user, jti: existing.jti, expiresAt: existing.expiresAt })
    ).rejects.toThrow()
  })
})
