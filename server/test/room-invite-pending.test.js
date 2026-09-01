import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { mailer } from '../src/services/email.service.js'
import { Room } from '../src/models/Room.js'
import { env } from '../src/config/env.js'

/**
 * Inviting somebody who has never heard of SyncSpace.
 *
 * Membership is by account id, so until an invitation like this one there was
 * nothing to point at and the invite was simply refused — which meant invites
 * only ever reached people who had already joined. That is the wrong way round:
 * an invitation is how most people would hear of the place at all. The address
 * is held on the room instead, and becomes a real membership the moment an
 * account exists under it.
 */

let app
let sent

const OWNER = { email: 'host@pending.test', password: 'host-passphrase-1', name: 'Priya' }
const NEWCOMER = { email: 'newcomer@pending.test', password: 'new-passphrase-1', name: 'Sam' }

const register = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

const invite = (token, roomId, body) =>
  request(app).post('/api/v1/rooms/' + roomId + '/invite').set(auth(token)).send(body)

const roster = (token, roomId) =>
  request(app).get('/api/v1/rooms/' + roomId + '/people').set(auth(token))

const cancel = (token, roomId, email) =>
  request(app)
    .delete('/api/v1/rooms/' + roomId + '/invites/' + encodeURIComponent(email))
    .set(auth(token))

async function makeRoom(token, overrides = {}) {
  const res = await request(app)
    .post('/api/v1/rooms')
    .set(auth(token))
    .send({ name: 'Design review', ...overrides })
  return res.body.room
}

const invitations = () => sent.filter((message) => message.subject.includes('invited you to'))

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
  sent = []
  vi.spyOn(mailer, 'send').mockImplementation(async (message) => {
    sent.push(message)
    return { delivered: true }
  })
})

afterEach(() => vi.restoreAllMocks())

describe('inviting an address with no account', () => {
  it('is accepted rather than refused', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, { email: NEWCOMER.email })

    expect(res.status).toBe(200)
    expect(res.body.invited).toMatchObject({
      id: null,
      email: NEWCOMER.email,
      pending: true,
      notified: true,
    })
  })

  it('emails them, leading with the account they have to make', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    await invite(owner.token, room.roomId, { email: NEWCOMER.email })
    const [message] = invitations()

    expect(message.to).toBe(NEWCOMER.email)
    expect(message.subject).toBe('Priya invited you to Design review on SyncSpace')

    // The room link alone would only turn them away, so signing up comes first
    // — but the code and the room are both there for afterwards.
    expect(message.text).toContain(env.CLIENT_URL + '/register')
    expect(message.text).toContain(env.CLIENT_URL + '/room/' + room.roomId)
    expect(message.text).toContain('room code: ' + room.roomId)
  })

  it('does not pretend they are a member yet', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, { email: NEWCOMER.email })
    expect(res.body.room.memberCount).toBe(1)
  })

  it('holds one invitation however many times it is sent', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    await invite(owner.token, room.roomId, { email: NEWCOMER.email })
    await invite(owner.token, room.roomId, { email: '  NEWCOMER@Pending.Test ' })

    const stored = await Room.findOne({ roomId: room.roomId })
    expect(stored.pendingInvites).toHaveLength(1)

    // Still worth re-sending, though: that is how an owner chases a guest who
    // never received the first one.
    expect(invitations()).toHaveLength(2)
  })

  it('shows up on the roster so the owner knows it is outstanding', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, { email: NEWCOMER.email, role: 'viewer' })

    const res = await roster(owner.token, room.roomId)

    expect(res.body.pending).toEqual([
      { email: NEWCOMER.email, role: 'viewer', at: expect.any(String) },
    ])
  })

  it('still refuses a user id that matches nobody', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, { userId: 'a'.repeat(24) })

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('user_not_found')
  })
})

describe('signing up against a waiting invitation', () => {
  it('joins the room as the account is created', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, { email: NEWCOMER.email })

    const joined = (await register(NEWCOMER)).body
    expect(joined.rooms).toEqual([room.roomId])

    const opened = await request(app)
      .get('/api/v1/rooms/' + room.roomId)
      .set(auth(joined.token))
    expect(opened.status).toBe(200)
  })

  it('takes the role the invitation was sent with', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, { email: NEWCOMER.email, role: 'viewer' })

    await register(NEWCOMER)
    const res = await roster(owner.token, room.roomId)

    expect(res.body.members).toContainEqual(
      expect.objectContaining({ email: NEWCOMER.email, role: 'viewer' })
    )
    expect(res.body.pending).toEqual([])
  })

  it('matches the address however either side typed it', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, { email: '  NEWCOMER@Pending.Test  ' })

    const joined = (await register({ ...NEWCOMER, email: 'NewComer@Pending.TEST' })).body
    expect(joined.rooms).toEqual([room.roomId])
  })

  it('collects every room they were invited to, not just the first', async () => {
    const owner = (await register(OWNER)).body
    const first = await makeRoom(owner.token, { name: 'One' })
    const second = await makeRoom(owner.token, { name: 'Two' })

    await invite(owner.token, first.roomId, { email: NEWCOMER.email })
    await invite(owner.token, second.roomId, { email: NEWCOMER.email })

    const joined = (await register(NEWCOMER)).body
    expect(joined.rooms.sort()).toEqual([first.roomId, second.roomId].sort())
  })

  it('leaves someone who was never invited exactly where they were', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    const stranger = (await register(NEWCOMER)).body
    expect(stranger.rooms).toEqual([])

    const opened = await request(app)
      .get('/api/v1/rooms/' + room.roomId)
      .set(auth(stranger.token))
    expect(opened.status).toBe(403)
  })
})

describe('withdrawing an invitation nobody took up', () => {
  it('stops the address being expected', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, { email: NEWCOMER.email })

    const res = await cancel(owner.token, room.roomId, NEWCOMER.email)
    expect(res.status).toBe(200)
    expect(res.body.cancelled).toEqual({ email: NEWCOMER.email })

    // And signing up now gets them nothing.
    const joined = (await register(NEWCOMER)).body
    expect(joined.rooms).toEqual([])
  })

  it('says so when there was no such invitation', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    const res = await cancel(owner.token, room.roomId, 'nobody@pending.test')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('invite_not_found')
  })

  it('refuses anyone but the owner', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, { email: NEWCOMER.email })

    const outsider = (await register({ ...NEWCOMER, email: 'other@pending.test' })).body
    const res = await cancel(outsider.token, room.roomId, NEWCOMER.email)

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_owner')
  })
})
