import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { Room } from '../src/models/Room.js'
import { Snapshot } from '../src/models/Snapshot.js'
import { DocUpdate } from '../src/models/DocUpdate.js'
import { Participant } from '../src/models/Participant.js'
import { recordParticipant } from '../src/services/room.service.js'

let app

const OWNER = { email: 'owner@syncspace.test', password: 'owner-passphrase-1', name: 'Owner' }
const OTHER = { email: 'other@syncspace.test', password: 'other-passphrase-1', name: 'Other' }

const register = (who) => request(app).post('/api/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

async function makeRoom(token, name = 'Design review') {
  const res = await request(app).post('/api/rooms').set(auth(token)).send({ name })
  return res.body.room.roomId
}

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
})

describe('deleting a room', () => {
  it('requires authentication', async () => {
    expect((await request(app).delete('/api/rooms/anything')).status).toBe(401)
  })

  it('404s an unknown room', async () => {
    const { body } = await register(OWNER)
    const res = await request(app).delete('/api/rooms/no-such-room').set(auth(body.token))
    expect(res.status).toBe(404)
  })

  it('refuses anyone who is not the owner', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = await makeRoom(owner.token)

    const res = await request(app).delete('/api/rooms/' + roomId).set(auth(other.token))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_owner')

    // ...and the room is still there.
    expect(await Room.countDocuments({ roomId })).toBe(1)
  })

  it('removes the room and everything belonging to it', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    await Snapshot.create({ roomId, state: Buffer.from([1, 2, 3]), seq: 2, size: 3 })
    await DocUpdate.create({ roomId, seq: 1, update: Buffer.from([1]), size: 1 })
    await DocUpdate.create({ roomId, seq: 2, update: Buffer.from([2]), size: 1 })
    await recordParticipant({ roomId, user: { id: owner.user.id, name: 'Owner' } })

    const res = await request(app).delete('/api/rooms/' + roomId).set(auth(owner.token))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ roomId, deletedUpdates: 2 })

    expect(await Room.countDocuments({ roomId })).toBe(0)
    expect(await Snapshot.countDocuments({ roomId })).toBe(0)
    expect(await DocUpdate.countDocuments({ roomId })).toBe(0)
    expect(await Participant.countDocuments({ roomId })).toBe(0)
  })

  it('purges the append-only log that normal deletes refuse to touch', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)
    await DocUpdate.create({ roomId, seq: 1, update: Buffer.from([1]), size: 1 })

    // The guard is still in force for ordinary callers...
    await expect(DocUpdate.deleteMany({ roomId })).rejects.toThrow(/append-only/)

    // ...but deleting the whole room is allowed to clear it.
    await request(app).delete('/api/rooms/' + roomId).set(auth(owner.token)).expect(200)
    expect(await DocUpdate.countDocuments({ roomId })).toBe(0)
  })

  it('drops the room off the owner dashboard', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    expect((await request(app).get('/api/rooms').set(auth(owner.token))).body.rooms).toHaveLength(1)

    await request(app).delete('/api/rooms/' + roomId).set(auth(owner.token)).expect(200)

    expect((await request(app).get('/api/rooms').set(auth(owner.token))).body.rooms).toHaveLength(0)
  })
})

describe('renaming and visibility', () => {
  it('requires authentication', async () => {
    expect((await request(app).patch('/api/rooms/anything').send({ name: 'x' })).status).toBe(401)
  })

  it('renames a room', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token, 'Untitled room')

    const res = await request(app)
      .patch('/api/rooms/' + roomId)
      .set(auth(owner.token))
      .send({ name: 'Candidate screen' })

    expect(res.status).toBe(200)
    expect(res.body.room.name).toBe('Candidate screen')
    expect((await Room.findOne({ roomId })).name).toBe('Candidate screen')
  })

  it('flips a room between private and public', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)
    expect((await Room.findOne({ roomId })).isPublic).toBe(false)

    await request(app)
      .patch('/api/rooms/' + roomId)
      .set(auth(owner.token))
      .send({ isPublic: true })
      .expect(200)
    expect((await Room.findOne({ roomId })).isPublic).toBe(true)

    await request(app)
      .patch('/api/rooms/' + roomId)
      .set(auth(owner.token))
      .send({ isPublic: false })
      .expect(200)
    expect((await Room.findOne({ roomId })).isPublic).toBe(false)
  })

  it('opens a public room to a stranger and closes it again', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = await makeRoom(owner.token)

    expect((await request(app).get('/api/rooms/' + roomId).set(auth(other.token))).status).toBe(403)

    await request(app)
      .patch('/api/rooms/' + roomId)
      .set(auth(owner.token))
      .send({ isPublic: true })
      .expect(200)

    expect((await request(app).get('/api/rooms/' + roomId).set(auth(other.token))).status).toBe(200)

    await request(app)
      .patch('/api/rooms/' + roomId)
      .set(auth(owner.token))
      .send({ isPublic: false })
      .expect(200)

    expect((await request(app).get('/api/rooms/' + roomId).set(auth(other.token))).status).toBe(403)
  })

  it('refuses anyone who is not the owner', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = await makeRoom(owner.token, 'Mine')

    const res = await request(app)
      .patch('/api/rooms/' + roomId)
      .set(auth(other.token))
      .send({ name: 'Hijacked' })

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_owner')
    expect((await Room.findOne({ roomId })).name).toBe('Mine')
  })

  it('rejects an empty name and an empty patch', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    expect(
      (await request(app).patch('/api/rooms/' + roomId).set(auth(owner.token)).send({ name: '   ' }))
        .status
    ).toBe(400)

    expect(
      (await request(app).patch('/api/rooms/' + roomId).set(auth(owner.token)).send({})).status
    ).toBe(400)
  })
})

describe('room roster', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/rooms/anything/people')).status).toBe(401)
  })

  it('lists the owner, invited members, and everyone who opened the room', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = await makeRoom(owner.token, 'Interview loop')

    await request(app)
      .post('/api/rooms/' + roomId + '/invite')
      .set(auth(owner.token))
      .send({ userId: other.user.id })
      .expect(200)

    await recordParticipant({ roomId, user: { id: other.user.id, name: 'Other' } })
    await recordParticipant({ roomId, user: { name: 'Candidate' } })

    const res = await request(app).get('/api/rooms/' + roomId + '/people').set(auth(owner.token))
    expect(res.status).toBe(200)

    expect(res.body.owner).toMatchObject({ name: 'Owner', email: OWNER.email })
    expect(res.body.members.map((m) => m.name).sort()).toEqual(['Other', 'Owner'])

    const guest = res.body.participants.find((p) => p.name === 'Candidate')
    expect(guest).toMatchObject({ guest: true, userId: null, visits: 1 })
    expect(res.body.participants.find((p) => p.name === 'Other')).toMatchObject({ guest: false })
  })

  it('counts repeat visits instead of duplicating a person', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    await recordParticipant({ roomId, user: { name: 'Candidate' } })
    await recordParticipant({ roomId, user: { name: 'Candidate' } })
    await recordParticipant({ roomId, user: { name: 'Candidate' } })

    const res = await request(app).get('/api/rooms/' + roomId + '/people').set(auth(owner.token))
    const rows = res.body.participants.filter((p) => p.name === 'Candidate')

    expect(rows).toHaveLength(1)
    expect(rows[0].visits).toBe(3)
  })

  it('hides the roster from people outside the room', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = await makeRoom(owner.token)

    const res = await request(app).get('/api/rooms/' + roomId + '/people').set(auth(other.token))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('room_forbidden')
  })

  it('lets an invited member see the roster', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = await makeRoom(owner.token)

    await request(app)
      .post('/api/rooms/' + roomId + '/invite')
      .set(auth(owner.token))
      .send({ userId: other.user.id })
      .expect(200)

    expect(
      (await request(app).get('/api/rooms/' + roomId + '/people').set(auth(other.token))).status
    ).toBe(200)
  })
})
