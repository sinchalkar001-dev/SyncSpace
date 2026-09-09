import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { RoomPreference } from '../src/models/RoomPreference.js'

/**
 * The things a room list needs before it can be a workspace: a room that says
 * what it is for, and a person's own opinion about where it belongs.
 *
 * The opinion is the part worth testing hardest. Pinning and archiving look
 * like ordinary room fields and are not — two people share a room and will not
 * agree about it — so the tests below care less that a pin is stored than that
 * one person's pin is invisible to the other.
 */

let app

const OWNER = { email: 'owner@syncspace.test', password: 'owner-passphrase-1', name: 'Owner' }
const OTHER = { email: 'other@syncspace.test', password: 'other-passphrase-1', name: 'Other' }

const register = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

const makeRoom = (token, body = {}) =>
  request(app).post('/api/v1/rooms').set(auth(token)).send({ name: 'Design review', ...body })

const listRooms = (token) => request(app).get('/api/v1/rooms').set(auth(token))

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
})

describe('what a room is for', () => {
  it('takes a type and a description when the room is created', async () => {
    const { body } = await register(OWNER)

    const res = await makeRoom(body.token, {
      name: 'Candidate screen',
      kind: 'interview',
      description: 'Two-sum, then scale it',
    })

    expect(res.status).toBe(201)
    expect(res.body.room).toMatchObject({
      name: 'Candidate screen',
      kind: 'interview',
      description: 'Two-sum, then scale it',
    })
  })

  /**
   * Unclassified, not miscellaneous. Every room made before this existed is
   * general, and nothing should have guessed a type for them from their names.
   */
  it('defaults to general rather than guessing', async () => {
    const { body } = await register(OWNER)
    const res = await makeRoom(body.token)

    expect(res.body.room.kind).toBe('general')
    expect(res.body.room.description).toBe('')
  })

  it('refuses a type it does not know', async () => {
    const { body } = await register(OWNER)
    const res = await makeRoom(body.token, { kind: 'retrospective' })
    expect(res.status).toBe(400)
  })

  it('changes them later, one field at a time', async () => {
    const { body } = await register(OWNER)
    const roomId = (await makeRoom(body.token)).body.room.roomId

    const res = await request(app)
      .patch('/api/v1/rooms/' + roomId)
      .set(auth(body.token))
      .send({ kind: 'system-design' })

    expect(res.status).toBe(200)
    expect(res.body.room.kind).toBe('system-design')
    // Untouched by a patch that did not mention it.
    expect(res.body.room.name).toBe('Design review')
  })

  /**
   * An empty description is a real edit - somebody clearing a line they no
   * longer want - which is why this field accepts the empty string where
   * `name` does not.
   */
  it('lets a description be cleared', async () => {
    const { body } = await register(OWNER)
    const roomId = (await makeRoom(body.token, { description: 'temporary' })).body.room.roomId

    const res = await request(app)
      .patch('/api/v1/rooms/' + roomId)
      .set(auth(body.token))
      .send({ description: '' })

    expect(res.status).toBe(200)
    expect(res.body.room.description).toBe('')
  })
})

describe('the room list a dashboard reads', () => {
  it('names the people in each room rather than only counting them', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = (await makeRoom(owner.token)).body.room.roomId

    await request(app)
      .post('/api/v1/rooms/' + roomId + '/invite')
      .set(auth(owner.token))
      .send({ email: OTHER.email })

    const res = await listRooms(owner.token)
    const room = res.body.rooms.find((entry) => entry.roomId === roomId)

    expect(room.memberCount).toBe(2)
    expect(room.collaborators.map((person) => person.name).sort()).toEqual(['Other', 'Owner'])
    expect(room.collaborators.every((person) => person.id)).toBe(true)
    expect(other.token).toBeTruthy()
  })

  it('reports no pin and no archive for a room nobody has an opinion about', async () => {
    const { body } = await register(OWNER)
    await makeRoom(body.token)

    const [room] = (await listRooms(body.token)).body.rooms
    expect(room.pinned).toBe(false)
    expect(room.archived).toBe(false)
  })
})

describe('pinning and archiving, per person', () => {
  it('records a pin and reports it back on the room list', async () => {
    const { body } = await register(OWNER)
    const roomId = (await makeRoom(body.token)).body.room.roomId

    const res = await request(app)
      .put('/api/v1/rooms/' + roomId + '/preferences')
      .set(auth(body.token))
      .send({ pinned: true })

    expect(res.status).toBe(200)
    expect(res.body.preference).toMatchObject({ roomId, pinned: true, archived: false })

    const [room] = (await listRooms(body.token)).body.rooms
    expect(room.pinned).toBe(true)
  })

  /**
   * The reason this is not a field on the room. Two people share one room and
   * one of them files it away; the other must not find it gone.
   */
  it('keeps one person opinion out of another person view of the same room', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = (await makeRoom(owner.token)).body.room.roomId

    await request(app)
      .post('/api/v1/rooms/' + roomId + '/invite')
      .set(auth(owner.token))
      .send({ email: OTHER.email })

    await request(app)
      .put('/api/v1/rooms/' + roomId + '/preferences')
      .set(auth(other.token))
      .send({ pinned: true, archived: true })

    const mine = (await listRooms(other.token)).body.rooms.find((r) => r.roomId === roomId)
    const theirs = (await listRooms(owner.token)).body.rooms.find((r) => r.roomId === roomId)

    expect(mine).toMatchObject({ pinned: true, archived: true })
    expect(theirs).toMatchObject({ pinned: false, archived: false })
  })

  /**
   * Two controls on one card write independently, so each has to be able to
   * say only what it changed.
   */
  it('leaves the field a request does not mention alone', async () => {
    const { body } = await register(OWNER)
    const roomId = (await makeRoom(body.token)).body.room.roomId
    const url = '/api/v1/rooms/' + roomId + '/preferences'

    await request(app).put(url).set(auth(body.token)).send({ pinned: true })
    const res = await request(app).put(url).set(auth(body.token)).send({ archived: true })

    expect(res.body.preference).toMatchObject({ pinned: true, archived: true })
  })

  it('is idempotent, so a retried click is not an error', async () => {
    const { body } = await register(OWNER)
    const roomId = (await makeRoom(body.token)).body.room.roomId
    const url = '/api/v1/rooms/' + roomId + '/preferences'

    await request(app).put(url).set(auth(body.token)).send({ pinned: true })
    const again = await request(app).put(url).set(auth(body.token)).send({ pinned: true })

    expect(again.status).toBe(200)
    expect(await RoomPreference.countDocuments({ roomId })).toBe(1)
  })

  it('unpins by saying so, and keeps the row', async () => {
    const { body } = await register(OWNER)
    const roomId = (await makeRoom(body.token)).body.room.roomId
    const url = '/api/v1/rooms/' + roomId + '/preferences'

    await request(app).put(url).set(auth(body.token)).send({ pinned: true })
    const res = await request(app).put(url).set(auth(body.token)).send({ pinned: false })

    expect(res.body.preference.pinned).toBe(false)
  })

  it('requires authentication', async () => {
    const res = await request(app).put('/api/v1/rooms/whatever/preferences').send({ pinned: true })
    expect(res.status).toBe(401)
  })

  it('rejects a request that decides nothing', async () => {
    const { body } = await register(OWNER)
    const roomId = (await makeRoom(body.token)).body.room.roomId

    const res = await request(app)
      .put('/api/v1/rooms/' + roomId + '/preferences')
      .set(auth(body.token))
      .send({})

    expect(res.status).toBe(400)
  })

  /**
   * Gated on seeing the room, which is not about protecting the preference: it
   * is about not letting a guess at a room code write a row that confirms the
   * room exists.
   */
  it('refuses a room the caller cannot see', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = (await makeRoom(owner.token)).body.room.roomId

    const res = await request(app)
      .put('/api/v1/rooms/' + roomId + '/preferences')
      .set(auth(other.token))
      .send({ pinned: true })

    expect(res.status).toBe(403)
    expect(await RoomPreference.countDocuments({})).toBe(0)
  })

  it('404s a room that does not exist', async () => {
    const { body } = await register(OWNER)
    const res = await request(app)
      .put('/api/v1/rooms/no-such-room/preferences')
      .set(auth(body.token))
      .send({ pinned: true })

    expect(res.status).toBe(404)
  })
})
