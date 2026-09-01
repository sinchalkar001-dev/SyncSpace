import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { mailer } from '../src/services/email.service.js'
import { env } from '../src/config/env.js'

/**
 * A private room cannot be found, guessed, or stumbled into — which makes the
 * invitation email the only thing that tells someone they are now welcome in
 * one. These tests are about that message: that it reaches the right address,
 * that it carries both ways in (the link and the code), and that nothing about
 * mail delivery can take an invite down with it.
 */

let app
let sent

const OWNER = { email: 'host@invite.test', password: 'host-passphrase-1', name: 'Priya' }
const GUEST = { email: 'guest@invite.test', password: 'guest-passphrase-1', name: 'Sam' }

const register = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

const invite = (token, roomId, body) =>
  request(app).post('/api/v1/rooms/' + roomId + '/invite').set(auth(token)).send(body)

async function makeRoom(token, overrides = {}) {
  const res = await request(app)
    .post('/api/v1/rooms')
    .set(auth(token))
    .send({ name: 'Design review', ...overrides })
  return res.body.room
}

/** Registration sends mail of its own; only the invitations matter here. */
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

describe('the invitation email', () => {
  it('goes to the person invited, and names who invited them to what', async () => {
    const owner = (await register(OWNER)).body
    await register(GUEST)
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, { email: GUEST.email })
    expect(res.status).toBe(200)

    const [message] = invitations()
    expect(message.to).toBe(GUEST.email)
    expect(message.subject).toBe('Priya invited you to Design review on SyncSpace')
    expect(message.text).toContain('Priya')
    expect(message.text).toContain('Design review')
  })

  it('carries both ways in: a link to the room, and the code on its own', async () => {
    const owner = (await register(OWNER)).body
    await register(GUEST)
    const room = await makeRoom(owner.token)

    await invite(owner.token, room.roomId, { email: GUEST.email })
    const [message] = invitations()

    const url = env.CLIENT_URL + '/room/' + room.roomId
    expect(message.text).toContain(url)
    expect(message.html).toContain('href="' + url + '"')

    // The code has to stand on its own as well: it is what gets typed into the
    // dashboard by someone who would rather not follow a link in an email.
    expect(message.text).toContain('room code: ' + room.roomId)
    expect(message.html).toContain('<strong>' + room.roomId + '</strong>')
  })

  it('escapes a room name rather than letting it become markup', async () => {
    const owner = (await register(OWNER)).body
    await register(GUEST)
    const room = await makeRoom(owner.token, { name: '<img src=x onerror=alert(1)>' })

    await invite(owner.token, room.roomId, { email: GUEST.email })
    const [message] = invitations()

    expect(message.html).not.toContain('<img')
    expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('reports who was let in, and that they were told', async () => {
    const owner = (await register(OWNER)).body
    const guest = (await register(GUEST)).body
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, { email: GUEST.email })

    expect(res.body.invited).toEqual({
      id: guest.user.id,
      name: 'Sam',
      email: GUEST.email,
      notified: true,
    })
  })

  it('notifies an invite made by user id, not only one made by address', async () => {
    const owner = (await register(OWNER)).body
    const guest = (await register(GUEST)).body
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, { userId: guest.user.id })

    expect(res.status).toBe(200)
    expect(invitations()[0].to).toBe(GUEST.email)
    expect(res.body.invited.notified).toBe(true)
  })

  /**
   * Inviting somebody already in the room changes no membership, but it is
   * also the only gesture an owner has for "they never got it" — so it sends
   * the code again rather than quietly doing nothing.
   */
  it('sends the code again when the same person is invited twice', async () => {
    const owner = (await register(OWNER)).body
    await register(GUEST)
    const room = await makeRoom(owner.token)

    await invite(owner.token, room.roomId, { email: GUEST.email })
    const second = await invite(owner.token, room.roomId, { email: GUEST.email })

    expect(second.status).toBe(200)
    expect(second.body.room.memberCount).toBe(2)
    expect(invitations()).toHaveLength(2)
  })

  it('tells someone let back in that they are welcome again', async () => {
    const owner = (await register(OWNER)).body
    const guest = (await register(GUEST)).body
    const room = await makeRoom(owner.token)

    await invite(owner.token, room.roomId, { email: GUEST.email })
    await request(app)
      .delete('/api/v1/rooms/' + room.roomId + '/members/' + guest.user.id)
      .set(auth(owner.token))

    sent = []
    const again = await invite(owner.token, room.roomId, { email: GUEST.email })

    expect(again.status).toBe(200)
    expect(invitations()).toHaveLength(1)
  })
})

describe('when the invitation cannot be sent', () => {
  it('still grants access, and says the invitee was not told', async () => {
    mailer.send.mockResolvedValue({ delivered: false })

    const owner = (await register(OWNER)).body
    const guest = (await register(GUEST)).body
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, { email: GUEST.email })

    expect(res.status).toBe(200)
    expect(res.body.invited.notified).toBe(false)

    // Access is what matters, and it is written before the mail is attempted:
    // a dead relay must not cost the guest their way into the room.
    expect(res.body.room.memberCount).toBe(2)
    const opened = await request(app)
      .get('/api/v1/rooms/' + room.roomId)
      .set(auth(guest.token))
    expect(opened.status).toBe(200)
  })

  it('survives a mailer that throws outright', async () => {
    mailer.send.mockRejectedValue(new Error('relay exploded'))

    const owner = (await register(OWNER)).body
    await register(GUEST)
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, { email: GUEST.email })

    expect(res.status).toBe(200)
    expect(res.body.invited.notified).toBe(false)
  })
})

describe('what never sends an invitation', () => {
  it('an address nobody has signed up with', async () => {
    const owner = (await register(OWNER)).body
    const room = await makeRoom(owner.token)

    const res = await invite(owner.token, room.roomId, { email: 'nobody@invite.test' })

    expect(res.status).toBe(404)
    expect(invitations()).toHaveLength(0)
  })

  it('an invite from somebody who does not own the room', async () => {
    const owner = (await register(OWNER)).body
    const guest = (await register(GUEST)).body
    const room = await makeRoom(owner.token)
    await invite(owner.token, room.roomId, { email: GUEST.email })

    sent = []
    const res = await invite(guest.token, room.roomId, { email: OWNER.email })

    expect(res.status).toBe(403)
    expect(invitations()).toHaveLength(0)
  })
})
