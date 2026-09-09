import * as Y from 'yjs'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { Activity, ACTIVITY } from '../src/models/Activity.js'
import {
  listActivityForRooms,
  listRoomActivity,
  recordActivity,
  resetActivityThrottle,
} from '../src/services/activity.service.js'
import { kindsChangedBy, watchDocument } from '../src/collab/document-activity.js'

/**
 * What the dashboard feed is built on.
 *
 * Two things here are load-bearing and neither is obvious from reading the
 * code. The first is that a document replays its entire history into itself
 * every time it loads, so a listener attached at the wrong moment would
 * announce that everybody had just edited everything, every time anyone opened
 * a room. The second is that the whiteboard and the code buffer share one Yjs
 * document, so telling them apart is a real question and not a lookup.
 */

let app

const OWNER = { email: 'owner@syncspace.test', password: 'owner-passphrase-1', name: 'Owner' }
const OTHER = { email: 'other@syncspace.test', password: 'other-passphrase-1', name: 'Other' }

const register = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

/** Recording is deliberately fire-and-forget, so tests wait for the row. */
async function settled(expected, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    if ((await Activity.countDocuments({})) >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  resetActivityThrottle()
  app = createApp()
})

describe('telling the two halves of a room apart', () => {
  it('calls a change to the code buffer an edit to the code', () => {
    const doc = new Y.Doc()
    let kinds = []
    doc.on('afterTransaction', (transaction) => {
      kinds = kindsChangedBy(doc, transaction)
    })

    doc.getText('code').insert(0, 'const answer = 42')
    expect(kinds).toEqual([ACTIVITY.CODE_EDITED])
  })

  it('calls a change to the shape list an update to the whiteboard', () => {
    const doc = new Y.Doc()
    let kinds = []
    doc.on('afterTransaction', (transaction) => {
      kinds = kindsChangedBy(doc, transaction)
    })

    doc.getArray('shapes').push([{ id: 's1', type: 'rect' }])
    expect(kinds).toEqual([ACTIVITY.WHITEBOARD_UPDATED])
  })

  /**
   * Moving one shape changes the map for that shape, not the array holding it,
   * so a naive check against the roots alone would see nothing at all.
   */
  it('follows a nested change back up to the whiteboard it belongs to', () => {
    const doc = new Y.Doc()
    const shape = new Y.Map()
    doc.getArray('shapes').push([shape])

    let kinds = []
    doc.on('afterTransaction', (transaction) => {
      kinds = kindsChangedBy(doc, transaction)
    })

    shape.set('x', 120)
    expect(kinds).toEqual([ACTIVITY.WHITEBOARD_UPDATED])
  })

  it('ignores parts of the document that are neither', () => {
    const doc = new Y.Doc()
    let kinds = []
    doc.on('afterTransaction', (transaction) => {
      kinds = kindsChangedBy(doc, transaction)
    })

    doc.getMap('meta').set('language', 'python')
    expect(kinds).toEqual([])
  })
})

describe('recording what somebody did to a document', () => {
  /** Hocuspocus applies a client update with the connection as the origin. */
  const asConnection = (user) => ({ context: { user } })

  it('names the person who typed, from the connection that carried the update', async () => {
    const doc = new Y.Doc()
    watchDocument('room-one', doc)

    doc.transact(() => doc.getText('code').insert(0, 'hello'), asConnection({ id: null, name: 'Ayush' }))

    await settled(1)
    const [row] = await listRoomActivity('room-one')
    expect(row).toMatchObject({ kind: ACTIVITY.CODE_EDITED, actorName: 'Ayush' })
  })

  /**
   * The guard that keeps the feed honest.
   *
   * Loading a room replays its snapshot and every update since into the
   * document. Those applies carry no origin, and without this check opening a
   * room would fill its own feed with edits nobody had just made.
   */
  it('records nothing for updates the server applies to itself', async () => {
    const source = new Y.Doc()
    source.getText('code').insert(0, 'a whole history')
    const update = Y.encodeStateAsUpdate(source)

    const doc = new Y.Doc()
    watchDocument('room-two', doc)

    // Exactly what replaying a snapshot looks like: no origin.
    Y.applyUpdate(doc, update)

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await Activity.countDocuments({ roomId: 'room-two' })).toBe(0)
  })

  it('collapses continuous typing into one line rather than one per keystroke', async () => {
    const doc = new Y.Doc()
    watchDocument('room-three', doc)
    const origin = asConnection({ id: null, name: 'Jishu' })

    for (let i = 0; i < 25; i += 1) {
      doc.transact(() => doc.getText('code').insert(0, 'x'), origin)
    }

    await settled(1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await Activity.countDocuments({ roomId: 'room-three' })).toBe(1)
  })

  it('still separates two people typing in the same room', async () => {
    const doc = new Y.Doc()
    watchDocument('room-four', doc)

    doc.transact(() => doc.getText('code').insert(0, 'a'), asConnection({ id: null, name: 'One' }))
    doc.transact(() => doc.getText('code').insert(0, 'b'), asConnection({ id: null, name: 'Two' }))

    await settled(2)
    const names = (await listRoomActivity('room-four')).map((row) => row.actorName).sort()
    expect(names).toEqual(['One', 'Two'])
  })

  /**
   * Two runs a second apart are two answers, and collapsing them would hide
   * whichever one failed - invariably the one somebody wanted to know about.
   */
  it('does not collapse finished runs', async () => {
    recordActivity({
      roomId: 'room-five',
      kind: ACTIVITY.EXECUTION_COMPLETED,
      actorName: 'Owner',
      detail: 'python ran cleanly',
    })
    recordActivity({
      roomId: 'room-five',
      kind: ACTIVITY.EXECUTION_COMPLETED,
      actorName: 'Owner',
      detail: 'python run failed',
    })

    await settled(2)
    expect(await Activity.countDocuments({ roomId: 'room-five' })).toBe(2)
  })

  it('drops a kind it does not recognise instead of storing it', async () => {
    recordActivity({ roomId: 'room-six', kind: 'room.exploded', actorName: 'Owner' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await Activity.countDocuments({ roomId: 'room-six' })).toBe(0)
  })
})

describe('reading a feed back', () => {
  it('returns nothing rather than everything for an empty room list', async () => {
    recordActivity({ roomId: 'somewhere', kind: ACTIVITY.CODE_EDITED, actorName: 'Owner' })
    await settled(1)
    expect(await listActivityForRooms([])).toEqual([])
  })

  it("reports a room's own feed, newest first", async () => {
    const { body } = await register(OWNER)
    const roomId = (
      await request(app).post('/api/v1/rooms').set(auth(body.token)).send({ name: 'Room' })
    ).body.room.roomId

    recordActivity({ roomId, kind: ACTIVITY.COLLABORATOR_JOINED, actorName: 'First' })
    await settled(1)
    recordActivity({ roomId, kind: ACTIVITY.EXECUTION_COMPLETED, actorName: 'Second' })
    await settled(2)

    const res = await request(app)
      .get('/api/v1/rooms/' + roomId + '/activity')
      .set(auth(body.token))

    expect(res.status).toBe(200)
    expect(res.body.activity[0].actorName).toBe('Second')
  })

  it("refuses a private room's feed to somebody who cannot open the room", async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = (
      await request(app).post('/api/v1/rooms').set(auth(owner.token)).send({ name: 'Room' })
    ).body.room.roomId

    const res = await request(app)
      .get('/api/v1/rooms/' + roomId + '/activity')
      .set(auth(other.token))

    expect(res.status).toBe(403)
  })

  /**
   * The dashboard feed spans rooms, so its access rule is the one that matters
   * most: it must never report what happened somewhere you are not.
   */
  it('spans only the rooms the caller belongs to', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body

    const mine = (
      await request(app).post('/api/v1/rooms').set(auth(owner.token)).send({ name: 'Mine' })
    ).body.room.roomId
    const theirs = (
      await request(app).post('/api/v1/rooms').set(auth(other.token)).send({ name: 'Theirs' })
    ).body.room.roomId

    recordActivity({ roomId: mine, kind: ACTIVITY.CODE_EDITED, actorName: 'Owner' })
    await settled(1)
    recordActivity({ roomId: theirs, kind: ACTIVITY.CODE_EDITED, actorName: 'Other' })
    await settled(2)

    const res = await request(app).get('/api/v1/activity').set(auth(owner.token))

    expect(res.status).toBe(200)
    expect(res.body.activity).toHaveLength(1)
    expect(res.body.activity[0].roomId).toBe(mine)
  })

  it('requires authentication for the dashboard feed', async () => {
    expect((await request(app).get('/api/v1/activity')).status).toBe(401)
  })

  it('caps how much can be asked for at once', async () => {
    const { body } = await register(OWNER)
    const res = await request(app).get('/api/v1/activity?limit=99999').set(auth(body.token))
    expect(res.status).toBe(200)
    expect(res.body.activity.length).toBeLessThanOrEqual(100)
  })
})
