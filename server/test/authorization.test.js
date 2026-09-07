import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { Room } from '../src/models/Room.js'
import { ROLES } from '../src/permissions.js'

/**
 * The roles, enforced over HTTP.
 *
 * `permissions.test.js` proves the model gives the right answer. This proves
 * the server actually asks it — which is the half that goes wrong, because a
 * capability is only real at the point some route remembers to check it.
 *
 * The escalation cases are the ones worth reading. A permission system is not
 * defeated by somebody calling an endpoint they cannot reach; it is defeated
 * by somebody who can legitimately reach the role endpoint using it to award
 * themselves one more rung, or by finding a second door — the invitation —
 * that grants the same thing without the same check.
 */

let app

const OWNER = { email: 'owner@authz.test', password: 'owner-passphrase-1', name: 'Owner' }
const SECOND = { email: 'second@authz.test', password: 'second-passphrase', name: 'Second' }
const THIRD = { email: 'third@authz.test', password: 'third-passphrase-1', name: 'Third' }

const register = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
})

async function makeRoom(token, body = { name: 'Roles' }) {
  const res = await request(app).post('/api/v1/rooms').set(auth(token)).send(body)
  return res.body.room.roomId
}

/** Puts somebody in the room at a given role, straight through the model. */
async function addMember(roomId, userId, role) {
  await Room.updateOne({ roomId }, { $push: { members: { user: userId, role } } })
}

const setRole = (roomId, token, userId, role) =>
  request(app).patch('/api/v1/rooms/' + roomId + '/members/' + userId).set(auth(token)).send({ role })

const runCode = (roomId, token) =>
  request(app)
    .post('/api/v1/rooms/' + roomId + '/run')
    .set(auth(token))
    .send({ language: 'javascript', code: 'console.log(1)' })

/** Owner plus one other person at `role`. */
async function roomWith(role) {
  const owner = (await register(OWNER)).body
  const other = (await register(SECOND)).body
  const roomId = await makeRoom(owner.token)
  await addMember(roomId, other.user.id, role)
  return { owner, other, roomId }
}

describe('running code', () => {
  it('is allowed for an editor, as it always was', async () => {
    const { other, roomId } = await roomWith(ROLES.EDITOR)
    expect((await runCode(roomId, other.token)).status).toBe(200)
  })

  /** The role exists precisely to grant this without granting editing. */
  it('is allowed for a runner', async () => {
    const { other, roomId } = await roomWith(ROLES.RUNNER)
    expect((await runCode(roomId, other.token)).status).toBe(200)
  })

  it('is refused for a viewer, with a reason that names the thing', async () => {
    const { other, roomId } = await roomWith(ROLES.VIEWER)
    const res = await runCode(roomId, other.token)

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('permission_denied')
    // Not "you do not have access to this room" — they are looking at it.
    expect(res.body.error.message).toContain('run code')
  })

  it('is refused for a commenter', async () => {
    const { other, roomId } = await roomWith(ROLES.COMMENTER)
    expect((await runCode(roomId, other.token)).status).toBe(403)
  })
})

describe('files', () => {
  const upload = (roomId, token) =>
    request(app)
      .post('/api/v1/rooms/' + roomId + '/files')
      .set(auth(token))
      .attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' })

  it('can be uploaded by an editor', async () => {
    const { other, roomId } = await roomWith(ROLES.EDITOR)
    expect((await upload(roomId, other.token)).status).toBe(201)
  })

  /**
   * All three in one room rather than a loop that re-registers: the sign-up
   * limiter is per app instance, and a loop calling register six times spends
   * the budget and fails on a 429 that looks nothing like a permission bug.
   */
  it('cannot be uploaded by a runner, a commenter or a viewer', async () => {
    const owner = (await register(OWNER)).body
    const runner = (await register(SECOND)).body
    const viewer = (await register(THIRD)).body
    const roomId = await makeRoom(owner.token)

    await addMember(roomId, runner.user.id, ROLES.RUNNER)
    await addMember(roomId, viewer.user.id, ROLES.VIEWER)

    for (const [role, who] of [[ROLES.RUNNER, runner], [ROLES.VIEWER, viewer]]) {
      const res = await upload(roomId, who.token)
      expect(res.status, role).toBe(403)
      expect(res.body.error.code, role).toBe('permission_denied')
    }
  })

  it('can still be listed by a viewer, who may look at everything', async () => {
    const { other, roomId } = await roomWith(ROLES.VIEWER)
    const res = await request(app).get('/api/v1/rooms/' + roomId + '/files').set(auth(other.token))
    expect(res.status).toBe(200)
  })
})

describe('managing the room', () => {
  const invite = (roomId, token, userId, role) =>
    request(app).post('/api/v1/rooms/' + roomId + '/invite').set(auth(token)).send({ userId, role })

  it('lets an admin invite people, which an editor cannot', async () => {
    const owner = (await register(OWNER)).body
    const admin = (await register(SECOND)).body
    const third = (await register(THIRD)).body
    const roomId = await makeRoom(owner.token)

    await addMember(roomId, admin.user.id, ROLES.ADMIN)
    expect((await invite(roomId, admin.token, third.user.id)).status).toBe(200)

    await Room.updateOne({ roomId }, { $set: { 'members.$[m].role': ROLES.EDITOR } }, {
      arrayFilters: [{ 'm.user': admin.user.id }],
    })
    const refused = await invite(roomId, admin.token, third.user.id)
    expect(refused.status).toBe(403)
  })

  it('lets an admin rename the room but not delete it', async () => {
    const { other, roomId } = await roomWith(ROLES.ADMIN)

    const renamed = await request(app)
      .patch('/api/v1/rooms/' + roomId)
      .set(auth(other.token))
      .send({ name: 'Renamed by admin' })
    expect(renamed.status).toBe(200)

    const deleted = await request(app).delete('/api/v1/rooms/' + roomId).set(auth(other.token))
    expect(deleted.status).toBe(403)
  })

  it('refuses an editor the settings entirely', async () => {
    const { other, roomId } = await roomWith(ROLES.EDITOR)

    const res = await request(app)
      .patch('/api/v1/rooms/' + roomId)
      .set(auth(other.token))
      .send({ name: 'Nope' })
    expect(res.status).toBe(403)
  })
})

describe('assigning roles', () => {
  it('lets an owner set a member’s role', async () => {
    const { owner, other, roomId } = await roomWith(ROLES.EDITOR)

    const res = await setRole(roomId, owner.token, other.user.id, ROLES.VIEWER)
    expect(res.status).toBe(200)

    const room = await Room.findOne({ roomId })
    expect(room.members.find((m) => String(m.user) === other.user.id).role).toBe(ROLES.VIEWER)
  })

  it('refuses a role nobody has heard of', async () => {
    const { owner, other, roomId } = await roomWith(ROLES.EDITOR)

    const res = await setRole(roomId, owner.token, other.user.id, 'superuser')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('refuses to change the role of somebody who is not in the room', async () => {
    const owner = (await register(OWNER)).body
    const stranger = (await register(SECOND)).body
    const roomId = await makeRoom(owner.token)

    const res = await setRole(roomId, owner.token, stranger.user.id, ROLES.VIEWER)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_a_member')
  })

  it('will not demote the owner through a membership row', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    const res = await setRole(roomId, owner.token, owner.user.id, ROLES.VIEWER)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('cannot_demote_owner')
  })
})

describe('privilege escalation, over HTTP', () => {
  /** An admin manufacturing a peer, through the role endpoint. */
  it('stops an admin appointing another admin', async () => {
    const owner = (await register(OWNER)).body
    const admin = (await register(SECOND)).body
    const target = (await register(THIRD)).body
    const roomId = await makeRoom(owner.token)

    await addMember(roomId, admin.user.id, ROLES.ADMIN)
    await addMember(roomId, target.user.id, ROLES.EDITOR)

    const res = await setRole(roomId, admin.token, target.user.id, ROLES.ADMIN)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('role_forbidden')
  })

  /**
   * The second door. Being allowed to invite is not the same as being allowed
   * to invite at any rank — without this check the invite endpoint hands out
   * exactly what the role endpoint just refused.
   */
  it('stops an admin inviting a new account straight in as an admin', async () => {
    const owner = (await register(OWNER)).body
    const admin = (await register(SECOND)).body
    const outsider = (await register(THIRD)).body
    const roomId = await makeRoom(owner.token)

    await addMember(roomId, admin.user.id, ROLES.ADMIN)

    const res = await request(app)
      .post('/api/v1/rooms/' + roomId + '/invite')
      .set(auth(admin.token))
      .send({ userId: outsider.user.id, role: ROLES.ADMIN })

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('role_forbidden')
  })

  it('stops an admin demoting the owner', async () => {
    const owner = (await register(OWNER)).body
    const admin = (await register(SECOND)).body
    const roomId = await makeRoom(owner.token)
    await addMember(roomId, admin.user.id, ROLES.ADMIN)

    const res = await setRole(roomId, admin.token, owner.user.id, ROLES.VIEWER)
    expect([400, 403]).toContain(res.status)

    const room = await Room.findOne({ roomId })
    expect(String(room.owner)).toBe(owner.user.id)
  })

  it('stops an editor promoting themselves', async () => {
    const { other, roomId } = await roomWith(ROLES.EDITOR)

    const res = await setRole(roomId, other.token, other.user.id, ROLES.ADMIN)
    expect(res.status).toBe(403)
  })

  it('lets an owner appoint an admin, which is the whole point of the rank', async () => {
    const { owner, other, roomId } = await roomWith(ROLES.EDITOR)

    const res = await setRole(roomId, owner.token, other.user.id, ROLES.ADMIN)
    expect(res.status).toBe(200)
  })
})

describe('transferring the room', () => {
  it('moves ownership and leaves the previous owner an admin', async () => {
    const { owner, other, roomId } = await roomWith(ROLES.EDITOR)

    const res = await request(app)
      .post('/api/v1/rooms/' + roomId + '/transfer')
      .set(auth(owner.token))
      .send({ userId: other.user.id })

    expect(res.status).toBe(200)

    const room = await Room.findOne({ roomId })
    expect(String(room.owner)).toBe(other.user.id)
    expect(room.members.find((m) => String(m.user) === owner.user.id).role).toBe(ROLES.ADMIN)
  })

  it('is refused to an admin', async () => {
    const owner = (await register(OWNER)).body
    const admin = (await register(SECOND)).body
    const roomId = await makeRoom(owner.token)
    await addMember(roomId, admin.user.id, ROLES.ADMIN)

    const res = await request(app)
      .post('/api/v1/rooms/' + roomId + '/transfer')
      .set(auth(admin.token))
      .send({ userId: admin.user.id })

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_owner')
  })

  it('refuses to transfer to somebody who is not in the room', async () => {
    const owner = (await register(OWNER)).body
    const stranger = (await register(SECOND)).body
    const roomId = await makeRoom(owner.token)

    const res = await request(app)
      .post('/api/v1/rooms/' + roomId + '/transfer')
      .set(auth(owner.token))
      .send({ userId: stranger.user.id })

    expect(res.status).toBe(404)
  })
})

describe('what a caller is told about itself', () => {
  it('comes back with the room, so the interface need not guess', async () => {
    const { other, roomId } = await roomWith(ROLES.RUNNER)

    const res = await request(app).get('/api/v1/rooms/' + roomId).set(auth(other.token))

    expect(res.body.access.role).toBe(ROLES.RUNNER)
    expect(res.body.access.capabilities).toContain('code:execute')
    expect(res.body.access.capabilities).not.toContain('code:edit')
    expect(res.body.access.assignable).toEqual([])
  })

  it('tells an owner what they may hand out', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    const res = await request(app).get('/api/v1/rooms/' + roomId).set(auth(owner.token))

    expect(res.body.access.role).toBe(ROLES.OWNER)
    expect(res.body.access.assignable).toContain(ROLES.ADMIN)
    expect(res.body.access.assignable).not.toContain(ROLES.OWNER)
  })

  it('marks a guest as one, and withholds what needs an account', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token, { name: 'Open', isPublic: true })

    const res = await request(app).get('/api/v1/rooms/' + roomId)

    expect(res.body.access.isGuest).toBe(true)
    expect(res.body.access.capabilities).toContain('code:edit')
    expect(res.body.access.capabilities).not.toContain('files:upload')
  })
})

describe('a room that only lets guests watch', () => {
  it('refuses a guest the things its guestRole withholds', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token, { name: 'Read only', isPublic: true })
    await Room.updateOne({ roomId }, { $set: { guestRole: ROLES.VIEWER } })

    const res = await request(app)
      .post('/api/v1/rooms/' + roomId + '/run')
      .send({ language: 'javascript', code: 'console.log(1)' })

    expect(res.status).toBe(403)

    // And the owner is unaffected by their own setting.
    expect((await runCode(roomId, owner.token)).status).toBe(200)
  })
})
