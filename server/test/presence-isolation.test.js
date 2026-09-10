import * as Y from 'yjs'
import request from 'supertest'
import { WebSocket } from 'ws'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMemoryMongo, stopMemoryMongo, waitFor } from './helpers/db.js'
import { startServer } from '../src/index.js'
import { DocUpdate } from '../src/models/DocUpdate.js'
import { Snapshot } from '../src/models/Snapshot.js'
import { Activity } from '../src/models/Activity.js'
import { Room } from '../src/models/Room.js'

/**
 * Presence is not history.
 *
 * Who is in a room, where their caret is and what they have selected travel as
 * Yjs awareness, which Hocuspocus applies to `document.awareness` and never to
 * the document. That is why none of it can reach the update log, a snapshot,
 * replay or the activity feed - and it is the kind of guarantee that survives
 * exactly until somebody routes presence through the document "to make it
 * persist". These tests are what would notice.
 *
 * The suite runs with PERSIST_UPDATE_LOG on and a 50ms snapshot debounce, so
 * "nothing was written" below is a real observation: the same connections
 * writing one character produce rows immediately, and the control case
 * proves it.
 */

let server
let counter = 0
const nextRoom = () => 'presence-' + Date.now() + '-' + (counter += 1)

function connect(room, token = 'anonymous') {
  const doc = new Y.Doc()
  const socket = new HocuspocusProviderWebsocket({
    url: 'ws://127.0.0.1:' + server.port + '/collab',
    WebSocketPolyfill: WebSocket,
  })
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: room, document: doc, token })

  return {
    doc,
    provider,
    close() {
      provider.destroy()
      socket.destroy()
    },
  }
}

const synced = (client, label) => waitFor(() => client.provider.isSynced, { label: label || 'sync' })

/** Long enough for any debounced snapshot to have been written, twice over. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 600))

async function historyOf(room) {
  const snapshot = await Snapshot.findOne({ roomId: room }).lean()
  return {
    updates: await DocUpdate.countDocuments({ roomId: room }),
    snapshot: snapshot ? { seq: snapshot.seq, size: snapshot.size } : null,
    activity: await Activity.countDocuments({ roomId: room }),
  }
}

/** A burst of everything presence ever sends, as fast as a busy room would. */
function chatter(client, count = 120) {
  client.provider.setAwarenessField('user', { id: null, name: 'Busy', color: '#f97316' })
  for (let i = 0; i < count; i += 1) {
    client.provider.setAwarenessField('cursor', { x: i, y: i * 2 })
    client.provider.setAwarenessField('presence', {
      v: 1,
      activity: 'editing',
      surface: 'code',
      file: 'Main.java',
      line: i,
      selected: ['s' + i],
      share: true,
      following: null,
    })
    client.provider.setAwarenessField('view', { cx: i, cy: i, scale: 1 })
  }
}

const seenBy = (client, predicate) =>
  waitFor(
    () => {
      for (const state of client.provider.awareness.getStates().values()) {
        if (predicate(state)) return state
      }
      return null
    },
    { label: 'presence reaching the other client' }
  )

beforeAll(async () => {
  await startMemoryMongo()
  server = await startServer({ port: 0, host: '127.0.0.1', connectDb: false })
}, 120000)

afterAll(async () => {
  await server.close()
  await stopMemoryMongo()
})

describe('presence and the document', () => {
  it('delivers a burst of presence without writing any of it down', async () => {
    const room = nextRoom()
    const a = connect(room)
    const b = connect(room)

    try {
      await synced(a)
      await synced(b)
      await settle()

      const before = await historyOf(room)

      chatter(a)
      const last = await seenBy(b, (state) => state.presence?.line === 119)
      expect(last.presence.file).toBe('Main.java')
      expect(last.view).toEqual({ cx: 119, cy: 119, scale: 1 })

      await settle()

      expect(await historyOf(room)).toEqual(before)
      expect(before.updates).toBe(0)
      expect(before.activity).toBe(0)
    } finally {
      a.close()
      b.close()
    }
  }, 30000)

  /**
   * Without this the test above could pass against a server that records
   * nothing at all. One character typed on the same connections has to show
   * up in the log, in the snapshot and in the feed.
   */
  it('still records a real edit on the same connections', async () => {
    const room = nextRoom()
    const a = connect(room)
    const b = connect(room)

    try {
      await synced(a)
      await synced(b)

      chatter(a, 20)
      a.doc.getText('code').insert(0, 'x')

      await waitFor(() => b.doc.getText('code').toString() === 'x', { label: 'edit propagation' })
      await settle()

      const after = await historyOf(room)
      expect(after.updates).toBeGreaterThan(0)
      expect(after.snapshot).not.toBeNull()
      expect(after.activity).toBeGreaterThan(0)
    } finally {
      a.close()
      b.close()
    }
  }, 30000)

  /**
   * Presence is self-reported, so a viewer can claim anything about what they
   * are doing. The claim reaches the room as a label; it cannot become an
   * edit, because the document write is refused by the connection itself.
   */
  it("lets a viewer's presence reach the room without it becoming a write", async () => {
    const room = nextRoom()
    const tokenFor = async (who) =>
      (await request(server.app ?? server).post('/api/v1/auth/register').send(who)).body

    const owner = await tokenFor({
      email: 'owner-' + room + '@presence.test',
      password: 'owner-passphrase-1',
      name: 'Owner',
    })
    const watcher = await tokenFor({
      email: 'watcher-' + room + '@presence.test',
      password: 'watcher-passphrase-1',
      name: 'Watcher',
    })

    await Room.create({
      roomId: room,
      owner: owner.user.id,
      isPublic: false,
      members: [
        { user: owner.user.id, role: 'owner' },
        { user: watcher.user.id, role: 'viewer' },
      ],
    })

    const editor = connect(room, owner.token)
    const viewer = connect(room, watcher.token)

    try {
      await synced(editor, 'owner sync')
      await synced(viewer, 'viewer sync')
      await settle()

      const before = await historyOf(room)

      viewer.provider.setAwarenessField('user', { id: watcher.user.id, name: 'Watcher', color: '#22d3ee' })
      viewer.provider.setAwarenessField('presence', {
        v: 1,
        activity: 'editing',
        surface: 'code',
        file: 'Main.java',
        line: 1,
        selected: null,
        share: true,
        following: null,
      })

      const claim = await seenBy(editor, (state) => state.user?.name === 'Watcher' && state.presence)
      expect(claim.presence.activity).toBe('editing')

      await settle()
      expect(await historyOf(room)).toEqual(before)
    } finally {
      editor.close()
      viewer.close()
    }
  }, 30000)

  /**
   * The privacy guarantee at the transport. Presence goes to whoever holds a
   * connection to the document, and a connection to a private room is refused
   * to anybody not on its list - so somebody turned away sees nobody's caret,
   * nobody's selection and nobody's name.
   */
  it('shows nobody in a private room to somebody who was refused it', async () => {
    const room = nextRoom()
    const tokenFor = async (who) =>
      (await request(server.app ?? server).post('/api/v1/auth/register').send(who)).body

    const owner = await tokenFor({
      email: 'owner-' + room + '@presence.test',
      password: 'owner-passphrase-1',
      name: 'Owner',
    })
    const stranger = await tokenFor({
      email: 'stranger-' + room + '@presence.test',
      password: 'stranger-passphrase-1',
      name: 'Stranger',
    })

    await Room.create({
      roomId: room,
      owner: owner.user.id,
      isPublic: false,
      members: [{ user: owner.user.id, role: 'owner' }],
    })

    const inside = connect(room, owner.token)
    const outside = connect(room, stranger.token)

    let refused = false
    outside.provider.on('authenticationFailed', () => {
      refused = true
    })

    try {
      await synced(inside, 'owner sync')
      await waitFor(() => refused, { label: 'stranger refused' })

      inside.provider.setAwarenessField('user', { id: owner.user.id, name: 'Owner', color: '#f97316' })
      inside.provider.setAwarenessField('presence', {
        v: 1,
        activity: 'editing',
        surface: 'code',
        file: 'Main.java',
        line: 7,
        selected: null,
        share: true,
        following: null,
      })

      await settle()

      const visible = [...outside.provider.awareness.getStates().values()]
      expect(visible.some((state) => state.user?.name === 'Owner')).toBe(false)
      expect(visible.some((state) => state.presence?.line === 7)).toBe(false)
    } finally {
      inside.close()
      outside.close()
    }
  }, 30000)
})
