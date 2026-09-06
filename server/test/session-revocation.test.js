import request from 'supertest'
import jwt from 'jsonwebtoken'
import { io as ioClient } from 'socket.io-client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { startServer } from '../src/index.js'
import { env } from '../src/config/env.js'
import { User } from '../src/models/User.js'
import { Session } from '../src/models/Session.js'
import { changePassword, login, register } from '../src/services/auth.service.js'
import { resetPassword } from '../src/services/password-reset.service.js'
import { hashToken, randomToken } from '../src/utils/token.js'

/**
 * Ending a session before its token expires.
 *
 * A signed JWT cannot be withdrawn — verifying one is arithmetic, and
 * arithmetic has no opinion about whether the account has changed since. The
 * only way to revoke one is to keep a record on this side to check it against,
 * which is what the Session collection is: a row per signed-in device, named
 * by the token's `jti`. Changing a password deletes them all and opens one
 * fresh, so every token minted before it stops naming anything.
 *
 * This runs against a real server rather than the app alone, because the
 * property has to hold at four separate doors — the two REST guards, the
 * collab handshake and the socket handshake — and because a token check only
 * bites at the *next* handshake. A connection that is already open was
 * authenticated minutes ago and nothing re-examines it, so it has to be hung
 * up as well.
 *
 * Accounts are made and passwords changed through the services rather than
 * over HTTP. One server serves this whole file, so the per-IP credential
 * budgets would otherwise accumulate across tests and start answering 429
 * halfway down — every other suite gets a fresh app, and its own counters,
 * from `createApp` in `beforeEach`. What is under test here is whether a token
 * is *accepted*, so the requests that matter are still real ones.
 */

let server
let base

const ALICE = { email: 'alice@syncspace.test', password: 'correct-horse-battery', name: 'Alice' }
const BOB = { email: 'bob@syncspace.test', password: 'a-different-passphrase', name: 'Bob' }
const NEXT_PASSWORD = 'an-entirely-new-passphrase'

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

/** The request whose answer is the whole question: is this token still good? */
const me = (token) =>
  request(base).get('/api/v1/auth/me').set('Authorization', 'Bearer ' + token)

const rotate = (userId, current = ALICE.password) =>
  changePassword(userId, current, NEXT_PASSWORD)

function connectSocket(auth = {}) {
  return ioClient(base, { path: '/socket.io', transports: ['websocket'], auth, reconnection: false })
}

const connected = (socket) =>
  new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket))
    socket.on('connect_error', reject)
  })

describe('changing a password ends the sessions opened under the old one', () => {
  it('refuses the token that was used to change it', async () => {
    const { user, token } = await register(ALICE)
    expect((await me(token)).status).toBe(200)

    await rotate(user.id)

    expect((await me(token)).status).toBe(401)
  })

  /**
   * The reason change-password has to answer a token at all: the caller was
   * holding one of the sessions it just ended, and without a replacement,
   * changing your password would sign you out of the tab you did it in.
   */
  it('hands back a token that works', async () => {
    const { user, token } = await register(ALICE)

    const changed = await rotate(user.id)

    expect(changed.token).toEqual(expect.any(String))
    expect(changed.token).not.toBe(token)
    expect((await me(changed.token)).status).toBe(200)
  })

  /** The route has to carry it through, not only the service. */
  it('is answered by the HTTP route too, not just the service', async () => {
    const { token } = await register(ALICE)

    const res = await request(base)
      .post('/api/v1/auth/change-password')
      .set('Authorization', 'Bearer ' + token)
      .send({ currentPassword: ALICE.password, newPassword: NEXT_PASSWORD })

    expect(res.status).toBe(200)
    expect(res.body.token).toEqual(expect.any(String))
    expect(res.body.user).toMatchObject({ email: ALICE.email })
    expect((await me(res.body.token)).status).toBe(200)
    expect((await me(token)).status).toBe(401)
  })

  it('says the session ended rather than that the token is malformed', async () => {
    const { user, token } = await register(ALICE)
    await rotate(user.id)

    const res = await me(token)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('session_revoked')
    expect(res.body.error.message).toMatch(/sign in again/i)
  })

  /** A second device, holding a token minted before the change. */
  it('refuses a token issued to another device before the change', async () => {
    const { user } = await register(ALICE)

    const laptop = await login({ email: ALICE.email, password: ALICE.password })
    const phone = await login({ email: ALICE.email, password: ALICE.password })

    await rotate(user.id)

    expect((await me(laptop.token)).status).toBe(401)
    expect((await me(phone.token)).status).toBe(401)
  })

  it('leaves everybody else signed in', async () => {
    const alice = await register(ALICE)
    const bob = await register(BOB)

    await rotate(alice.user.id)

    expect((await me(bob.token)).status).toBe(200)
  })

  it('does not end sessions when the current password was wrong', async () => {
    const { user, token } = await register(ALICE)

    await expect(rotate(user.id, 'not-the-current-password')).rejects.toMatchObject({
      code: 'bad_password',
    })

    expect((await me(token)).status).toBe(200)
  })
})

describe('resetting a password ends them too', () => {
  /**
   * This is where revocation earns its keep. Someone who resets a password
   * they cannot remember often does so because somebody else can, and a reset
   * that left the intruder's token working would be the appearance of security
   * rather than security.
   */
  it('refuses a token issued before the reset', async () => {
    const { token } = await register(ALICE)

    // The link is planted directly rather than read out of the email, which
    // the password-reset suites already cover end to end; what is under test
    // here is only what a reset does to sessions.
    const raw = randomToken()
    const user = await User.findOne({ email: ALICE.email })
    user.resetTokenHash = hashToken(raw)
    user.resetTokenExpiresAt = new Date(Date.now() + 60_000)
    await user.save()

    const session = await resetPassword(raw, NEXT_PASSWORD)

    expect((await me(token)).status).toBe(401)
    // And the one the reset itself answered is the session that survives.
    expect((await me(session.token)).status).toBe(200)
  })
})

describe('tokens that predate sessions being recorded', () => {
  /**
   * A perfectly signed token with no `jti` names no session, so there is
   * nothing to check it against and — more to the point — no way to revoke it.
   *
   * It is refused rather than grandfathered. Accepting it would leave tokens
   * that "sign out every other device" cannot reach, which is exactly the hole
   * this whole mechanism exists to close; a device list that quietly omits
   * some of what is signed in would be worse than none. The price is that
   * deploying signs everyone out once, which is a known, one-time cost.
   */
  it('refuses a token that names no session', async () => {
    const { user } = await register(ALICE)

    const legacy = jwt.sign({ sub: user.id, name: user.name }, env.JWT_SECRET, { expiresIn: '7d' })

    const res = await me(legacy)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('session_revoked')
  })

  /** Nor one whose session row has gone, however it went. */
  it('refuses a token whose session row no longer exists', async () => {
    const { token } = await register(ALICE)
    expect((await me(token)).status).toBe(200)

    await Session.deleteMany({})

    expect((await me(token)).status).toBe(401)
  })

  /**
   * A token naming an account that no longer exists is left to the route,
   * which answers 404 for it. Nothing about that case concerns sessions, and
   * turning it into a 401 here would change a documented response.
   */
  it('leaves a token for a deleted account to the route it was aimed at', async () => {
    const { user, token } = await register(ALICE)
    await User.deleteOne({ _id: user.id })

    expect((await me(token)).status).toBe(404)
  })
})

describe('live connections', () => {
  it('refuses a socket handshake carrying a revoked token', async () => {
    const { user, token } = await register(ALICE)

    const before = connectSocket({ token })
    await connected(before)
    before.disconnect()

    await rotate(user.id)

    const after = connectSocket({ token })
    await expect(connected(after)).rejects.toThrow(/session ended/i)
    after.disconnect()
  })

  /**
   * The half a token check cannot cover. This connection authenticated before
   * the password changed and nothing would ever ask it again, so leaving it
   * alone would lock the old device out of the API while letting it carry on
   * typing in the room — the one thing the person changing their password is
   * trying to stop.
   */
  it('hangs up a socket that was already open', async () => {
    const { user, token } = await register(ALICE)

    const socket = connectSocket({ token })
    await connected(socket)

    const ended = new Promise((resolve) => socket.on('session:ended', resolve))
    const closed = new Promise((resolve) => socket.on('disconnect', resolve))

    await rotate(user.id)

    expect(await ended).toMatchObject({ reason: 'password_changed' })
    await closed
    expect(socket.connected).toBe(false)

    socket.disconnect()
  })

  it('leaves other people connected', async () => {
    const alice = await register(ALICE)
    const bob = await register(BOB)

    const hers = connectSocket({ token: alice.token })
    const his = connectSocket({ token: bob.token })
    await Promise.all([connected(hers), connected(his)])

    let hisEnded = false
    his.on('session:ended', () => {
      hisEnded = true
    })

    const ended = new Promise((resolve) => hers.on('session:ended', resolve))
    await rotate(alice.user.id)
    await ended

    expect(hisEnded).toBe(false)
    expect(his.connected).toBe(true)

    hers.disconnect()
    his.disconnect()
  })

  /** A guest carries a random id in the same field; it must never collide. */
  it('leaves anonymous visitors alone', async () => {
    const { user, token } = await register(ALICE)

    const guest = connectSocket({ user: { name: 'Visitor' } })
    await connected(guest)

    const mine = connectSocket({ token })
    await connected(mine)

    const ended = new Promise((resolve) => mine.on('session:ended', resolve))
    await rotate(user.id)
    await ended

    expect(guest.connected).toBe(true)

    guest.disconnect()
    mine.disconnect()
  })
})
