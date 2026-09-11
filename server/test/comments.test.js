import * as Y from 'yjs'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { setIo } from '../src/realtime/registry.js'
import { CAPABILITIES, ROLES, can, capabilitiesFor } from '../src/permissions.js'
import { Room } from '../src/models/Room.js'
import { File } from '../src/models/File.js'
import { Participant } from '../src/models/Participant.js'
import { resetTimelineCache } from '../src/services/session-timeline.service.js'

/**
 * Comment threads, through the API.
 *
 * Four accounts with four roles, because the rules are about roles: a viewer
 * reads and cannot write, a commenter writes, an editor also moderates, and
 * somebody who never came near the room cannot be dragged into it by a
 * mention.
 */

let app
let owner
let editor
let commenter
let viewer
let stranger

const ROOM = 'comment-room'
const auth = (who) => ({ Authorization: 'Bearer ' + who.token })
const base = '/api/v1/rooms/' + ROOM + '/comments'

async function register(name) {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: name.toLowerCase() + '@comments.test', password: name + '-passphrase-1', name })
  return res.body
}

const REGION = { kind: 'region', x: 120, y: 80, width: 0, height: 0 }

const open = (who, body = {}) =>
  request(app)
    .post(base)
    .set(auth(who))
    .send({ anchor: REGION, text: 'Is this the right place for the cache?', ...body })

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  resetTimelineCache()
  app = createApp()

  owner = await register('Ada')
  editor = await register('Eve')
  commenter = await register('Cam')
  viewer = await register('Vic')
  stranger = await register('Sid')

  await Room.create({
    roomId: ROOM,
    name: 'Design review',
    owner: owner.user.id,
    isPublic: false,
    members: [
      { user: owner.user.id, role: 'owner' },
      { user: editor.user.id, role: 'editor' },
      { user: commenter.user.id, role: 'commenter' },
      { user: viewer.user.id, role: 'viewer' },
    ],
  })
})

describe('who may read and write', () => {
  it('lets anybody who can open the room read its threads', async () => {
    await open(commenter)
    const res = await request(app).get(base).set(auth(viewer))

    expect(res.status).toBe(200)
    expect(res.body.threads).toHaveLength(1)
  })

  /** The role exists to talk about the work without changing it. */
  it('lets a commenter comment, and names them as the author', async () => {
    const res = await open(commenter)

    expect(res.status).toBe(201)
    expect(res.body.thread).toMatchObject({ status: 'open', createdByName: 'Cam', version: 1 })
    expect(res.body.thread.messages[0]).toMatchObject({
      authorName: 'Cam',
      body: 'Is this the right place for the cache?',
      deleted: false,
    })
    expect(res.body.thread.events.map((event) => event.type)).toEqual(['opened'])
  })

  it('refuses a viewer', async () => {
    expect((await open(viewer)).status).toBe(403)
  })

  it('refuses somebody with no account, because a comment names its author for good', async () => {
    const res = await request(app).post(base).send({ anchor: REGION, text: 'hello' })
    expect(res.status).toBe(401)
  })

  it('refuses somebody outside a private room, reading or writing', async () => {
    expect((await request(app).get(base).set(auth(stranger))).status).toBe(403)
    expect((await open(stranger)).status).toBe(403)
  })

  it('refuses an empty comment', async () => {
    expect((await open(commenter, { text: '   ' })).status).toBe(400)
  })
})

describe('a thread over time', () => {
  it('keeps replies in order, and counts every change in its version', async () => {
    const id = (await open(commenter)).body.thread.id

    await request(app).post(base + '/' + id + '/replies').set(auth(editor)).send({ text: 'Yes, in front of the API.' })
    const res = await request(app)
      .post(base + '/' + id + '/replies')
      .set(auth(commenter))
      .send({ text: 'Good, resolving.' })

    expect(res.status).toBe(201)
    expect(res.body.thread.messages.map((message) => message.authorName)).toEqual(['Cam', 'Eve', 'Cam'])
    expect(res.body.thread.version).toBe(3)
    expect(res.body.thread.events.map((event) => event.type)).toEqual(['opened', 'replied', 'replied'])
  })

  /** A click retried after a timeout must not leave two "resolved" events behind. */
  it('resolves and reopens, recording each once however often it is asked', async () => {
    const id = (await open(commenter)).body.thread.id
    const resolve = (resolved) =>
      request(app).patch(base + '/' + id).set(auth(editor)).send({ resolved })

    await resolve(true)
    const twice = await resolve(true)
    expect(twice.body.thread).toMatchObject({ status: 'resolved', resolvedByName: 'Eve' })

    const reopened = await resolve(false)
    expect(reopened.body.thread.status).toBe('open')
    expect(reopened.body.thread.events.map((event) => event.type)).toEqual(['opened', 'resolved', 'reopened'])
  })

  it('lets only the author edit a message', async () => {
    const thread = (await open(commenter)).body.thread
    const url = base + '/' + thread.id + '/messages/' + thread.messages[0].id

    expect((await request(app).patch(url).set(auth(editor)).send({ text: 'rewritten' })).status).toBe(403)

    const own = await request(app).patch(url).set(auth(commenter)).send({ text: 'Is this right for the cache?' })
    expect(own.status).toBe(200)
    expect(own.body.thread.messages[0].body).toBe('Is this right for the cache?')
    expect(own.body.thread.messages[0].editedAt).toBeTruthy()
  })

  /**
   * The words go and the place stays: a deleted comment should not linger in
   * the database, and replay should still show that it was said.
   */
  it('lets the author or a moderator delete, keeping the event and dropping the words', async () => {
    const thread = (await open(editor)).body.thread
    const reply = (
      await request(app).post(base + '/' + thread.id + '/replies').set(auth(commenter)).send({ text: 'mine' })
    ).body.thread.messages[1]

    const theirs = base + '/' + thread.id + '/messages/' + thread.messages[0].id
    expect((await request(app).delete(theirs).set(auth(commenter))).status).toBe(403)

    const moderated = await request(app)
      .delete(base + '/' + thread.id + '/messages/' + reply.id)
      .set(auth(editor))

    expect(moderated.status).toBe(200)
    expect(moderated.body.thread.messages[1]).toMatchObject({ body: '', deleted: true, mentions: [] })
    expect(moderated.body.thread.events.at(-1)).toMatchObject({ type: 'deleted', byName: 'Eve' })
  })

  it('404s a thread that is not in this room', async () => {
    const res = await request(app).patch(base + '/nope').set(auth(editor)).send({ resolved: true })
    expect(res.status).toBe(404)
  })
})

describe('mentions', () => {
  /** A public room is open to every account; a mention must not reach all of them. */
  it('keeps only people who belong to the room', async () => {
    const res = await open(commenter, {
      text: '@Eve and @Sid, have a look',
      mentions: [editor.user.id, stranger.user.id],
    })

    expect(res.body.thread.messages[0].mentions).toEqual([editor.user.id])
  })

  it('counts somebody who has opened a public room as belonging to it', async () => {
    await Room.updateOne({ roomId: ROOM }, { $set: { isPublic: true } })
    await Participant.create({ roomId: ROOM, userKey: 'user:' + stranger.user.id, user: stranger.user.id, name: 'Sid' })

    const res = await open(commenter, { text: '@Sid', mentions: [stranger.user.id] })
    expect(res.body.thread.messages[0].mentions).toEqual([stranger.user.id])
  })
})

describe('anchors', () => {
  /** A comment pointing at another room's file, or relabelling one, is what trusting the label would allow. */
  it('checks a file belongs to the room, and names it from the database', async () => {
    const file = await File.create({
      roomId: ROOM,
      userId: owner.user.id,
      originalName: 'spec.pdf',
      storedName: 'stored-spec.pdf',
      mimeType: 'application/pdf',
      size: 10,
    })

    const res = await open(commenter, { anchor: { kind: 'file', fileId: String(file._id), label: 'forged.exe' } })
    expect(res.status).toBe(201)
    expect(res.body.thread.anchor).toMatchObject({ kind: 'file', fileId: String(file._id), label: 'spec.pdf' })

    const missing = await open(commenter, { anchor: { kind: 'file', fileId: '65f0000000000000000000ff' } })
    expect(missing.status).toBe(404)
  })

  it('keeps a code range as positions that follow the text, and refuses one without a range', async () => {
    const doc = new Y.Doc()
    const code = doc.getText('code')
    code.insert(0, 'function login(user) {\n  return check(user)\n}\n')
    const position = (index, assoc = 0) =>
      Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(code, index, assoc))).toString('base64')

    const anchor = {
      kind: 'code',
      start: position(23),
      end: position(42, -1),
      line: 2,
      endLine: 2,
      startColumn: 1,
      endColumn: 20,
      snippet: '  return check(user)',
    }

    const res = await open(commenter, { anchor })
    expect(res.status).toBe(201)
    expect(res.body.thread.anchor).toMatchObject({ kind: 'code', start: anchor.start, end: anchor.end, line: 2 })

    const noRange = await open(commenter, { anchor: { kind: 'code', line: 2 } })
    expect(noRange.status).toBe(400)

    const notBase64 = await open(commenter, { anchor: { ...anchor, start: 'not base64!' } })
    expect(notBase64.status).toBe(400)
  })

  it('keeps a shape anchor as a place on the shape, not on the board', async () => {
    const res = await open(commenter, {
      anchor: { kind: 'shape', shapeId: 's1', offsetX: 0.25, offsetY: 1.5, x: 10, y: 20, label: 'Database' },
    })

    expect(res.status).toBe(400)

    const ok = await open(commenter, {
      anchor: { kind: 'shape', shapeId: 's1', offsetX: 0.25, offsetY: 0.75, x: 10, y: 20, label: 'Database' },
    })
    expect(ok.body.thread.anchor).toMatchObject({ kind: 'shape', shapeId: 's1', offsetX: 0.25, offsetY: 0.75 })
  })
})

describe('telling the room', () => {
  let emitted

  beforeEach(() => {
    emitted = []
    setIo({ to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) })
  })

  afterEach(() => setIo(null))

  /**
   * The whole thread, every time. A client that missed one announcement is
   * put right by the next, rather than applying a patch to a copy it never had.
   */
  it('announces every change to the room with the whole thread', async () => {
    const id = (await open(commenter)).body.thread.id
    await request(app).post(base + '/' + id + '/replies').set(auth(editor)).send({ text: 'agreed' })
    await request(app).patch(base + '/' + id).set(auth(editor)).send({ resolved: true })

    expect(emitted.map((entry) => entry.room)).toEqual([ROOM, ROOM, ROOM])
    expect(emitted.map((entry) => entry.event)).toEqual(['comment:thread', 'comment:thread', 'comment:thread'])
    expect(emitted.map((entry) => entry.payload.thread.version)).toEqual([1, 2, 3])
    expect(emitted.at(-1).payload.thread.status).toBe('resolved')
  })

  it('announces nothing for a resolve that changed nothing', async () => {
    const id = (await open(commenter)).body.thread.id
    await request(app).patch(base + '/' + id).set(auth(editor)).send({ resolved: false })
    expect(emitted).toHaveLength(1)
  })

  /**
   * The announcement usually reaches the author before the response does. The
   * ref lets their client swap its placeholder for the saved thread instead of
   * showing both; it is echoed once, on the new thread, and kept nowhere.
   */
  it('echoes the author’s ref with a new thread, and only then', async () => {
    const id = (await open(commenter, { ref: 'pending-thread-abc-1' })).body.thread.id
    await request(app).post(base + '/' + id + '/replies').set(auth(editor)).send({ text: 'agreed' })

    expect(emitted[0].payload.ref).toBe('pending-thread-abc-1')
    expect(emitted[1].payload).not.toHaveProperty('ref')

    const listed = await request(app).get(base).set(auth(owner))
    expect(JSON.stringify(listed.body)).not.toContain('pending-thread-abc-1')
  })
})

describe('the capabilities behind it', () => {
  const room = {
    roomId: 'r',
    owner: 'o',
    isPublic: true,
    guestRole: ROLES.EDITOR,
    members: [],
    blocked: [],
    hasMember: () => false,
    isBlocked: () => false,
  }

  it('gives commenting to every role from commenter up, and moderating from editor up', () => {
    expect(capabilitiesFor(ROLES.VIEWER)).not.toContain(CAPABILITIES.COMMENT_WRITE)
    for (const role of [ROLES.COMMENTER, ROLES.RUNNER, ROLES.EDITOR, ROLES.ADMIN, ROLES.OWNER]) {
      expect(capabilitiesFor(role)).toContain(CAPABILITIES.COMMENT_WRITE)
    }

    expect(capabilitiesFor(ROLES.COMMENTER)).not.toContain(CAPABILITIES.COMMENT_MODERATE)
    for (const role of [ROLES.EDITOR, ROLES.ADMIN, ROLES.OWNER]) {
      expect(capabilitiesFor(role)).toContain(CAPABILITIES.COMMENT_MODERATE)
    }
  })

  /** A guest in a public room is an editor, and still cannot comment: there is nobody to name. */
  it('never lets a guest comment, whatever the room gives guests', () => {
    expect(can(room, null, CAPABILITIES.COMMENT_WRITE)).toBe(false)
    expect(can(room, null, CAPABILITIES.CODE_EDIT)).toBe(true)
  })
})

describe('reading state and history', () => {
  it('remembers when each person last looked, for the notification indicator', async () => {
    const before = await request(app).get(base).set(auth(editor))
    expect(before.body.seenAt).toBeNull()

    await request(app).post(base + '/seen').set(auth(editor))
    const after = await request(app).get(base).set(auth(editor))
    expect(after.body.seenAt).toBeTruthy()

    // Per person: somebody else has still seen nothing.
    expect((await request(app).get(base).set(auth(commenter))).body.seenAt).toBeNull()
  })

  it('puts comments opened and resolved into the session timeline', async () => {
    const id = (await open(commenter)).body.thread.id
    await request(app).patch(base + '/' + id).set(auth(editor)).send({ resolved: true })

    const res = await request(app).get('/api/v1/rooms/' + ROOM + '/history/timeline').set(auth(owner))
    const comments = res.body.timeline.events.filter((event) => event.kind.startsWith('comment.'))

    expect(comments.map((event) => event.actor + ' ' + event.text)).toEqual([
      'Cam commented on the whiteboard',
      'Eve resolved a comment on the whiteboard',
    ])
  })
})
