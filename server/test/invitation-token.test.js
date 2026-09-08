import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { env } from '../src/config/env.js'
import { Room } from '../src/models/Room.js'
import { User } from '../src/models/User.js'
import { clearOutbox, lastMessage } from '../src/services/email.service.js'

/**
 * Invitations that can be expired, spent, and pointed at one address.
 *
 * An invitation used to be a row saying "this address is expected" — enough to
 * let somebody in when they signed up, and nothing else. It could not expire,
 * could not be used once, and could not be told apart from a guess at an
 * address. A room invited to in March was still standing in December.
 *
 * The cases worth reading are the last three. A forwarded invitation must not
 * be a way into somebody else's room; a spent one must not work twice; and an
 * invitation must not be a way around proving you can read the mailbox it was
 * sent to, which is the one an invitation is most tempting to skip.
 */

let app

const OWNER = { email: 'owner@invite.test', password: 'owner-passphrase-1', name: 'Priya' }
const NEWCOMER = { email: 'newcomer@invite.test', password: 'newcomer-passphrase', name: 'Sam' }
const STRANGER = { email: 'stranger@invite.test', password: 'stranger-passphrase', name: 'Alex' }

const register = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

const original = { require: env.REQUIRE_EMAIL_VERIFICATION, hours: env.INVITATION_EXPIRY_HOURS }

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  clearOutbox()
  app = createApp()
})

afterEach(() => {
  env.REQUIRE_EMAIL_VERIFICATION = original.require
  env.INVITATION_EXPIRY_HOURS = original.hours
})

async function makeRoom(token, name = 'Design review') {
  const res = await request(app).post('/api/v1/rooms').set(auth(token)).send({ name })
  return res.body.room
}

const invite = (token, roomId, email) =>
  request(app).post('/api/v1/rooms/' + roomId + '/invite').set(auth(token)).send({ email })

/** The token as the invited person receives it: out of their email. */
const tokenFromEmail = (to) =>
  lastMessage(to)?.text.match(/accept-invitation\?token=([A-Za-z0-9_-]+)/)?.[1] ?? null

/** Registers and verifies, which is what an invitation now waits for. */
async function registerVerified(who) {
  const { body } = await register(who)
  await User.updateOne({ email: who.email }, { $set: { emailVerified: true, emailVerifiedAt: new Date() } })
  return body
}

const accept = (token, auth_) =>
  request(app).post('/api/v1/invitations/' + token + '/accept').set(auth(auth_))

describe('what an invitation to a new address produces', () => {
  it('emails a token, and stores only its hash', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    await invite(owner.token, room.roomId, NEWCOMER.email)

    const token = tokenFromEmail(NEWCOMER.email)
    expect(token).toBeTruthy()

    const stored = await Room.findOne({ roomId: room.roomId })
    const [held] = stored.pendingInvites

    expect(held.tokenHash).toBeTruthy()
    expect(held.tokenHash).not.toBe(token)
    expect(held.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('says what it is for, without saying who else is in the room', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, NEWCOMER.email)

    const res = await request(app).get('/api/v1/invitations/' + tokenFromEmail(NEWCOMER.email))

    expect(res.status).toBe(200)
    expect(res.body.invitation.roomName).toBe('Design review')
    expect(res.body.invitation.invitedBy).toBe('Priya')
    // Not a directory: nothing about members, and no address.
    expect(JSON.stringify(res.body)).not.toContain(NEWCOMER.email)
    expect(res.body.invitation.members).toBeUndefined()
  })

  it('replaces the previous token when the owner invites again', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    await invite(owner.token, room.roomId, NEWCOMER.email)
    const first = tokenFromEmail(NEWCOMER.email)

    await invite(owner.token, room.roomId, NEWCOMER.email)
    const second = tokenFromEmail(NEWCOMER.email)

    expect(second).not.toBe(first)
    expect((await request(app).get('/api/v1/invitations/' + first)).status).toBe(404)
    expect((await request(app).get('/api/v1/invitations/' + second)).status).toBe(200)
  })
})

describe('accepting one', () => {
  /**
   * Verification enforced throughout, because that is when the token is the
   * way in. Without it the invitation is claimed as the account is created —
   * which is the behaviour rooms have always had, and worth keeping — and
   * there is nothing left to present.
   */
  beforeEach(() => {
    env.REQUIRE_EMAIL_VERIFICATION = true
  })

  it('turns the invitation into a membership', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, NEWCOMER.email)
    const token = tokenFromEmail(NEWCOMER.email)

    const newcomer = await registerVerified(NEWCOMER)
    const res = await accept(token, newcomer.token)

    expect(res.status).toBe(200)
    expect(res.body.room.roomId).toBe(room.roomId)

    const stored = await Room.findOne({ roomId: room.roomId })
    expect(stored.hasMember(newcomer.user.id)).toBe(true)
  })

  /** Single-use, and not by a flag somebody could forget to filter on. */
  it('cannot be used twice', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, NEWCOMER.email)
    const token = tokenFromEmail(NEWCOMER.email)

    const newcomer = await registerVerified(NEWCOMER)
    expect((await accept(token, newcomer.token)).status).toBe(200)

    const again = await accept(token, newcomer.token)
    expect(again.status).toBe(404)
    expect(again.body.error.code).toBe('invitation_invalid')

    const stored = await Room.findOne({ roomId: room.roomId })
    expect(stored.pendingInvites).toHaveLength(0)
  })

  it('stops working once it has expired', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, NEWCOMER.email)
    const token = tokenFromEmail(NEWCOMER.email)

    await Room.updateOne(
      { roomId: room.roomId },
      { $set: { 'pendingInvites.0.expiresAt': new Date(Date.now() - 1000) } }
    )

    const newcomer = await registerVerified(NEWCOMER)
    const res = await accept(token, newcomer.token)

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('invitation_invalid')
  })

  /**
   * The binding that makes a token worth having. Without it, forwarding the
   * email is a way into somebody else's room.
   */
  it('refuses an account the invitation was not sent to', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, NEWCOMER.email)
    const token = tokenFromEmail(NEWCOMER.email)

    const stranger = await registerVerified(STRANGER)
    const res = await accept(token, stranger.token)

    expect(res.status).toBe(404)
    // The same refusal as an unknown token: telling them which address it was
    // for is exactly what the binding is protecting.
    expect(res.body.error.code).toBe('invitation_invalid')

    const stored = await Room.findOne({ roomId: room.roomId })
    expect(stored.hasMember(stranger.user.id)).toBe(false)
    // And it is still there for the person it belongs to.
    expect(stored.pendingInvites).toHaveLength(1)
  })

  it('refuses a token that never existed', async () => {
    const newcomer = await registerVerified(NEWCOMER)

    expect((await accept('a'.repeat(43), newcomer.token)).status).toBe(404)
    expect((await accept('nope', newcomer.token)).status).toBe(400)
  })

  it('needs an account at all', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, NEWCOMER.email)

    const res = await request(app)
      .post('/api/v1/invitations/' + tokenFromEmail(NEWCOMER.email) + '/accept')

    expect(res.status).toBe(401)
  })

  /**
   * The invitation has to be issued before the account exists — an address
   * that already has one is added as a member outright, with no token to
   * redeem — so the removal happens after they sign up and before they accept.
   */
  it('will not let somebody removed from the room back in', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    await invite(owner.token, room.roomId, NEWCOMER.email)
    const token = tokenFromEmail(NEWCOMER.email)

    const newcomer = await registerVerified(NEWCOMER)
    await Room.updateOne(
      { roomId: room.roomId },
      { $push: { blocked: { user: newcomer.user.id, at: new Date() } } }
    )

    const res = await accept(token, newcomer.token)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('room_forbidden')
  })
})

describe('an invitation is not a way around verification', () => {
  it('refuses an account that has not proven its address', async () => {
    env.REQUIRE_EMAIL_VERIFICATION = true

    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, NEWCOMER.email)
    const token = tokenFromEmail(NEWCOMER.email)

    // Registered, not verified.
    const { body } = await register(NEWCOMER)

    const res = await accept(token, body.token)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('email_not_verified')

    const stored = await Room.findOne({ roomId: room.roomId })
    expect(stored.hasMember(body.user.id)).toBe(false)
  })

  /**
   * The other door into the same room: an invitation used to be claimed the
   * moment an account appeared under a matching address. A tokened one is not,
   * and that is the point — it is redeemed by presenting it, so it cannot be
   * spent by something the invited person never did.
   */
  it('is not claimed merely by signing up with the invited address', async () => {
    env.REQUIRE_EMAIL_VERIFICATION = true

    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, NEWCOMER.email)
    const token = tokenFromEmail(NEWCOMER.email)

    const { body } = await register(NEWCOMER)
    expect(body.rooms).toEqual([])

    let stored = await Room.findOne({ roomId: room.roomId })
    expect(stored.hasMember(body.user.id)).toBe(false)

    // Verifying does not let them in either — the invitation is still theirs
    // to present, and still there to be presented.
    const code = lastMessage(NEWCOMER.email).text.match(/\b(\d{6})\b/)[1]
    await request(app)
      .post('/api/v1/auth/verify-email')
      .set(auth(body.token))
      .send({ code })
      .expect(200)

    stored = await Room.findOne({ roomId: room.roomId })
    expect(stored.hasMember(body.user.id)).toBe(false)
    expect(stored.pendingInvites).toHaveLength(1)

    // Presenting it is what does.
    expect((await accept(token, body.token)).status).toBe(200)

    stored = await Room.findOne({ roomId: room.roomId })
    expect(stored.hasMember(body.user.id)).toBe(true)
  })

  /**
   * Invitations sent before tokens existed have nothing to present, so they
   * are still claimed on sign-up. Without this, everybody holding one of those
   * would be stranded by the upgrade with no way to redeem it.
   */
  it('still claims a legacy invitation that has no token', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, NEWCOMER.email)

    // Strip the token, which is exactly what an invitation written by the
    // previous version looks like.
    await Room.updateOne(
      { roomId: room.roomId },
      { $unset: { 'pendingInvites.0.tokenHash': '', 'pendingInvites.0.expiresAt': '' } }
    )

    const { body } = await register(NEWCOMER)
    expect(body.rooms).toContain(room.roomId)
  })
})
