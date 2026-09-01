import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { Room } from '../src/models/Room.js'
import { recordParticipant } from '../src/services/room.service.js'

/**
 * Inviting people by the address their host actually knows, and putting
 * someone out again. Removal is the interesting half: a public room hands out
 * access to anyone holding the link, so dropping a membership is not enough on
 * its own to keep a person out.
 */

let app

const OWNER = { email: 'host@members.test', password: 'host-passphrase-1', name: 'Host' }
const GUEST = { email: 'guest@members.test', password: 'guest-passphrase-1', name: 'Guest' }
const OTHER = { email: 'other@members.test', password: 'other-passphrase-1', name: 'Other' }

const register = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

const invite = (token, roomId, body) =>
  request(app).post('/api/v1/rooms/' + roomId + '/invite').set(auth(token)).send(body)

const remove = (token, roomId, userId) =>
  request(app).delete('/api/v1/rooms/' + roomId + '/members/' + userId).set(auth(token))

const unblock = (token, roomId, userId) =>
  request(app).delete('/api/v1/rooms/' + roomId + '/blocked/' + userId).set(auth(token))

const openRoom = (token, roomId) =>
  request(app).get('/api/v1/rooms/' + roomId).set(auth(token))

async function makeRoom(token, overrides = {}) {
  const res = await request(app)
    .post('/api/v1/rooms')
    .set(auth(token))
    .send({ name: 'Interview', ...overrides })
  return res.body.room
}

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
})

describe('inviting by email', () => {
  it('lets the invited account open a private room', async () => {
    const owner = (await register(OWNER)).body
    const guest = (await register(GUEST)).body
    const room = await makeRoom(owner.token)

    expect((await openRoom(guest.token, room.roomId)).status).toBe(403)

    const res = await invite(owner.token, room.roomId, { email: GUEST.email })
    expect(res.status).toBe(200)
    expect(res.body.room.memberCount).toBe(2)

    expect((await openRoom(guest.token, room.roomId)).status).toBe(200)
    expect(guest.user.id).toBeTruthy()
  })

  it('matches the address however it was typed', async () => {
    const owner = (await register(OWNER)).body
    await register(GUEST)
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, { email: '  GUEST@Members.Test  ' })
    expect(res.status).toBe(200)
    expect(res.body.room.memberCount).toBe(2)
  })

  /**
   * This used to be a 404. It is the ordinary case — most people an owner
   * wants have not signed up yet — so the address is held on the room instead
   * and becomes a membership when an account appears under it. Covered in full
   * by room-invite-pending.test.js; kept here so the two halves of "invite by
   * email" are visible side by side.
   */
  it('holds an invitation for an address nobody has signed up with', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, { email: 'nobody@members.test' })

    expect(res.status).toBe(200)
    expect(res.body.invited).toMatchObject({ email: 'nobody@members.test', pending: true })
    // Held, not granted: nobody is in the room until they exist.
    expect(res.body.room.memberCount).toBe(1)
  })

  it('refuses a body that names the invitee twice', async () => {
    const owner = (await register(OWNER)).body
    const guest = (await register(GUEST)).body
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, {
      email: GUEST.email,
      userId: guest.user.id,
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('refuses an address that is not an address', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, { email: 'not-an-address' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })
})

describe('removing someone from a room', () => {
  it('drops the membership and shuts a private room again', async () => {
    const owner = (await register(OWNER)).body
    const guest = (await register(GUEST)).body
    const room = await makeRoom(owner.token)

    await invite(owner.token, room.roomId, { email: GUEST.email }).expect(200)
    expect((await openRoom(guest.token, room.roomId)).status).toBe(200)

    const res = await remove(owner.token, room.roomId, guest.user.id)
    expect(res.status).toBe(200)
    expect(res.body.removed).toMatchObject({ id: guest.user.id, email: GUEST.email })

    expect((await openRoom(guest.token, room.roomId)).status).toBe(403)
    expect((await request(app).get('/api/v1/rooms').set(auth(guest.token))).body.rooms).toEqual([])
  })

  it('keeps the person out of a public room too, link or no link', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const room = await makeRoom(owner.token, { isPublic: true })

    expect((await openRoom(other.token, room.roomId)).status).toBe(200)

    await remove(owner.token, room.roomId, other.user.id).expect(200)

    const res = await openRoom(other.token, room.roomId)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('room_forbidden')
  })

  it('forgets that they were ever in the room', async () => {
    const owner = (await register(OWNER)).body
    const guest = (await register(GUEST)).body
    const room = await makeRoom(owner.token)

    await invite(owner.token, room.roomId, { email: GUEST.email }).expect(200)
    await recordParticipant({
      roomId: room.roomId,
      user: { id: guest.user.id, name: GUEST.name, anonymous: false },
    })

    await remove(owner.token, room.roomId, guest.user.id).expect(200)

    const roster = await request(app)
      .get('/api/v1/rooms/' + room.roomId + '/people')
      .set(auth(owner.token))

    expect(roster.body.members.map((member) => member.id)).not.toContain(guest.user.id)
    expect(roster.body.participants.map((person) => person.userId)).not.toContain(guest.user.id)
    expect(roster.body.blocked).toMatchObject([{ id: guest.user.id, name: GUEST.name }])
  })

  it('refuses anyone but the owner', async () => {
    const owner = (await register(OWNER)).body
    const guest = (await register(GUEST)).body
    const room = await makeRoom(owner.token)

    await invite(owner.token, room.roomId, { email: GUEST.email }).expect(200)

    const res = await remove(guest.token, room.roomId, owner.user.id)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_owner')
    expect((await openRoom(owner.token, room.roomId)).status).toBe(200)
  })

  it('will not remove the owner from their own room', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    const res = await remove(owner.token, room.roomId, owner.user.id)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('cannot_remove_owner')
  })

  it('rejects an id that is not an id', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    const res = await remove(owner.token, room.roomId, 'nonsense')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('404s a user id nobody owns', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    const res = await remove(owner.token, room.roomId, '0123456789abcdef01234567')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('user_not_found')
  })
})

describe('letting a removed person back in', () => {
  it('reopens a public room without making them a member', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const room = await makeRoom(owner.token, { isPublic: true })

    await remove(owner.token, room.roomId, other.user.id).expect(200)
    expect((await openRoom(other.token, room.roomId)).status).toBe(403)

    await unblock(owner.token, room.roomId, other.user.id).expect(200)

    expect((await openRoom(other.token, room.roomId)).status).toBe(200)
    expect((await Room.findOne({ roomId: room.roomId })).members).toHaveLength(1)
  })

  it('is what an invite does as well, so a re-invite is not a dead end', async () => {
    const owner = (await register(OWNER)).body
    const guest = (await register(GUEST)).body
    const room = await makeRoom(owner.token)

    await invite(owner.token, room.roomId, { email: GUEST.email }).expect(200)
    await remove(owner.token, room.roomId, guest.user.id).expect(200)
    await invite(owner.token, room.roomId, { email: GUEST.email }).expect(200)

    expect((await openRoom(guest.token, room.roomId)).status).toBe(200)
    expect((await Room.findOne({ roomId: room.roomId })).blocked).toHaveLength(0)
  })

  it('says nothing changed rather than failing on someone who was never removed', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const room = await makeRoom(owner.token)

    await unblock(owner.token, room.roomId, other.user.id).expect(200)
    expect((await Room.findOne({ roomId: room.roomId })).blocked).toHaveLength(0)
  })

  it('refuses anyone but the owner', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const room = await makeRoom(owner.token, { isPublic: true })

    await remove(owner.token, room.roomId, other.user.id).expect(200)

    const res = await unblock(other.token, room.roomId, other.user.id)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_owner')
  })
})
