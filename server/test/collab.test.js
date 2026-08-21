import * as Y from 'yjs'
import request from 'supertest'
import { WebSocket } from 'ws'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMemoryMongo, stopMemoryMongo, waitFor } from './helpers/db.js'
import { startServer } from '../src/index.js'
import { DocUpdate } from '../src/models/DocUpdate.js'
import { Snapshot } from '../src/models/Snapshot.js'
import { Room } from '../src/models/Room.js'

let server
let roomCounter = 0

/** Unique room per test so documents never linger between cases. */
const nextRoom = () => 'room-' + Date.now() + '-' + (roomCounter += 1)

function connect(room, token = 'anonymous') {
  const doc = new Y.Doc()
  const socket = new HocuspocusProviderWebsocket({
    url: 'ws://127.0.0.1:' + server.port + '/collab',
    WebSocketPolyfill: WebSocket,
  })
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: room,
    document: doc,
    token,
  })

  return {
    doc,
    provider,
    close() {
      provider.destroy()
      socket.destroy()
    },
  }
}

const synced = (client, label) =>
  waitFor(() => client.provider.isSynced, { label: label || 'sync' })

beforeAll(async () => {
  await startMemoryMongo()
  server = await startServer({ port: 0, host: '127.0.0.1', connectDb: false })
}, 120000)

afterAll(async () => {
  await server.close()
  await stopMemoryMongo()
})

describe('two clients in one room', () => {
  it('propagates canvas and code edits between clients', async () => {
    const room = nextRoom()
    const a = connect(room)
    const b = connect(room)

    try {
      await synced(a)
      await synced(b)

      a.doc.getText('code').insert(0, 'const answer = 42')
      a.doc.getArray('shapes').push([{ id: 's1', type: 'rect', width: 10, height: 4 }])

      await waitFor(
        () =>
          b.doc.getText('code').toString() === 'const answer = 42' &&
          b.doc.getArray('shapes').length === 1,
        { label: 'A -> B propagation' }
      )

      expect(b.doc.getArray('shapes').toJSON()).toEqual([
        { id: 's1', type: 'rect', width: 10, height: 4 },
      ])

      // ...and back the other way.
      b.doc.getText('code').insert(17, ' // checked')
      await waitFor(() => a.doc.getText('code').toString().includes('// checked'), {
        label: 'B -> A propagation',
      })
    } finally {
      a.close()
      b.close()
    }
  })

  it('merges simultaneous edits at the same position without losing either', async () => {
    const room = nextRoom()
    const a = connect(room)
    const b = connect(room)

    try {
      await synced(a)
      await synced(b)

      a.doc.getText('code').insert(0, 'base')
      await waitFor(() => b.doc.getText('code').toString() === 'base', { label: 'seed' })

      // Both clients write to offset 0 before either has seen the other.
      a.doc.getText('code').insert(0, 'AAA')
      b.doc.getText('code').insert(0, 'BBB')

      await waitFor(
        () => a.doc.getText('code').toString() === b.doc.getText('code').toString(),
        { label: 'convergence' }
      )

      const result = a.doc.getText('code').toString()
      expect(result).toHaveLength('AAABBBbase'.length)
      expect(result).toContain('AAA')
      expect(result).toContain('BBB')
      expect(result).toContain('base')
    } finally {
      a.close()
      b.close()
    }
  })

  it('shares awareness state between clients', async () => {
    const room = nextRoom()
    const a = connect(room)
    const b = connect(room)

    try {
      await synced(a)
      await synced(b)

      a.provider.setAwarenessField('user', { id: 'u1', name: 'Alice', color: '#f97316' })
      a.provider.setAwarenessField('cursor', { x: 120, y: 40 })

      const seen = await waitFor(
        () => {
          for (const state of b.provider.awareness.getStates().values()) {
            if (state.user?.name === 'Alice') return state
          }
          return null
        },
        { label: 'awareness broadcast' }
      )

      expect(seen.user.color).toBe('#f97316')
      expect(seen.cursor).toEqual({ x: 120, y: 40 })
    } finally {
      a.close()
      b.close()
    }
  })
})

describe('persistence', () => {
  it('writes an append-only log and a snapshot, then reloads from them', async () => {
    const room = nextRoom()
    const first = connect(room)

    await synced(first)
    first.doc.getText('code').insert(0, 'function persisted() {}')
    first.doc.getArray('shapes').push([{ id: 'p1', type: 'ellipse' }])

    await waitFor(() => DocUpdate.countDocuments({ roomId: room }).then((n) => n > 0), {
      label: 'update log written',
    })

    // Closing the last connection unloads the document and flushes the snapshot.
    first.close()

    const snapshot = await waitFor(() => Snapshot.findOne({ roomId: room }), {
      label: 'snapshot stored',
    })
    expect(snapshot.state.byteLength).toBeGreaterThan(0)
    expect(snapshot.size).toBeGreaterThan(0)

    const room_ = await Room.findOne({ roomId: room })
    expect(room_.isPublic).toBe(true)

    // A brand new client must receive the persisted document.
    const second = connect(room)
    try {
      await synced(second, 'reload sync')
      await waitFor(
        () => second.doc.getText('code').toString() === 'function persisted() {}',
        { label: 'state restored from mongo' }
      )
      expect(second.doc.getArray('shapes').toJSON()).toEqual([{ id: 'p1', type: 'ellipse' }])
    } finally {
      second.close()
    }
  })

  it('exposes the session through the replay API', async () => {
    const room = nextRoom()
    const client = connect(room)

    try {
      await synced(client)
      client.doc.getText('code').insert(0, 'step one')
      await waitFor(() => DocUpdate.countDocuments({ roomId: room }).then((n) => n >= 1), {
        label: 'first update logged',
      })

      client.doc.getText('code').insert(8, ' / step two')
      await waitFor(() => DocUpdate.countDocuments({ roomId: room }).then((n) => n >= 2), {
        label: 'second update logged',
      })

      const timeline = await request(server.app).get('/api/v1/rooms/' + room + '/replay')
      expect(timeline.status).toBe(200)
      expect(timeline.body.timeline.length).toBeGreaterThanOrEqual(2)
      expect(timeline.body.timeline.map((e) => e.seq)).toEqual(
        [...timeline.body.timeline].map((e) => e.seq).sort((x, y) => x - y)
      )

      // Rewinding to seq 1 must show the document before the second edit.
      const rewound = await request(server.app)
        .get('/api/v1/rooms/' + room + '/replay/1')
        .buffer(true)
        .parse((res, callback) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => callback(null, Buffer.concat(chunks)))
        })

      expect(rewound.status).toBe(200)

      const rebuilt = new Y.Doc()
      Y.applyUpdate(rebuilt, new Uint8Array(rewound.body))
      expect(rebuilt.getText('code').toString()).toBe('step one')
      rebuilt.destroy()
    } finally {
      client.close()
    }
  })
})

describe('access control', () => {
  it('refuses an anonymous client on a private room', async () => {
    const room = nextRoom()
    await Room.create({ roomId: room, name: 'Private', isPublic: false })

    const client = connect(room)
    const failures = []
    client.provider.on('authenticationFailed', (event) => failures.push(event))

    try {
      await waitFor(() => failures.length > 0, { label: 'authentication rejected' })
      expect(client.provider.isSynced).toBe(false)
      expect(client.doc.getText('code').toString()).toBe('')
    } finally {
      client.close()
    }
  })

  it('admits an anonymous client to a public room', async () => {
    const room = nextRoom()
    const client = connect(room)
    try {
      await synced(client, 'public room sync')
      expect(client.provider.isSynced).toBe(true)
    } finally {
      client.close()
    }
  })
})
