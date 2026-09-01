import * as Y from 'yjs'
import request from 'supertest'
import { WebSocket } from 'ws'
import { io as ioClient } from 'socket.io-client'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMemoryMongo, stopMemoryMongo, waitFor } from './helpers/db.js'
import { startServer } from '../src/index.js'

/**
 * Removing someone has to take effect while they are sitting in the room, not
 * at their next reload — otherwise the person you just put out keeps typing on
 * the whiteboard. Both transports are checked here because they fail
 * independently: the document travels over Hocuspocus and presence over
 * Socket.io.
 *
 * This file runs its own server so its registrations get their own rate-limit
 * budget.
 */

let server

const OWNER = { email: 'kick-owner@live.test', password: 'owner-passphrase-1', name: 'Owner' }
const GUEST = { email: 'kick-guest@live.test', password: 'guest-passphrase-1', name: 'Guest' }

const auth = (token) => ({ Authorization: 'Bearer ' + token })

async function register(who) {
  const res = await request(server.app).post('/api/v1/auth/register').send(who)
  if (res.status !== 201) throw new Error('register failed: ' + res.status)
  return res.body
}

function collab(room, token) {
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

function channel(token) {
  return ioClient('http://127.0.0.1:' + server.port, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
  })
}

const connected = (socket) =>
  new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket))
    socket.on('connect_error', reject)
  })

const join = (socket, roomId) =>
  new Promise((resolve) => socket.emit('room:join', { roomId }, resolve))

let owner
let guest

beforeAll(async () => {
  await startMemoryMongo()
  server = await startServer({ port: 0, host: '127.0.0.1', connectDb: false })
  owner = await register(OWNER)
  guest = await register(GUEST)
}, 120000)

afterAll(async () => {
  await server.close()
  await stopMemoryMongo()
})

async function roomWithGuest(overrides = {}) {
  const created = await request(server.app)
    .post('/api/v1/rooms')
    .set(auth(owner.token))
    .send({ name: 'Interview', ...overrides })

  await request(server.app)
    .post('/api/v1/rooms/' + created.body.room.roomId + '/invite')
    .set(auth(owner.token))
    .send({ email: GUEST.email })
    .expect(200)

  return created.body.room.roomId
}

const removeGuest = (roomId) =>
  request(server.app)
    .delete('/api/v1/rooms/' + roomId + '/members/' + guest.user.id)
    .set(auth(owner.token))

describe('removing someone who is in the room', () => {
  it('cuts off their document and tells them why', async () => {
    const roomId = await roomWithGuest()
    const client = collab(roomId, guest.token)
    const failures = []

    try {
      await waitFor(() => client.provider.isSynced, { label: 'guest synced' })
      client.provider.on('authenticationFailed', (event) => failures.push(event))

      await removeGuest(roomId).expect(200)

      const failure = await waitFor(() => failures[0], { label: 'guest refused on reconnect' })
      expect(failure.reason).toMatch(/removed from this room/i)
      expect(client.provider.isSynced).toBe(false)
    } finally {
      client.close()
    }
  }, 20000)

  it('drops them from presence and refuses the rejoin', async () => {
    const roomId = await roomWithGuest({ isPublic: true })
    const ownerSocket = channel(owner.token)
    const guestSocket = channel(guest.token)
    const kicked = []
    const presence = []

    try {
      await connected(ownerSocket)
      await connected(guestSocket)
      guestSocket.on('room:kicked', (payload) => kicked.push(payload))
      ownerSocket.on('room:presence', (payload) => presence.push(payload))

      expect((await join(ownerSocket, roomId)).ok).toBe(true)
      expect((await join(guestSocket, roomId)).ok).toBe(true)

      await removeGuest(roomId).expect(200)

      const event = await waitFor(() => kicked[0], { label: 'guest kicked' })
      expect(event).toMatchObject({ roomId, reason: 'removed_by_owner' })

      const latest = await waitFor(
        () => presence.filter((entry) => entry.members.length === 1).pop(),
        { label: 'presence shrank to the owner' }
      )
      expect(latest.members[0].user.name).toBe('Owner')

      // The room is public, so only the block stands between them and a rejoin.
      expect((await join(guestSocket, roomId)).error).toBe('forbidden')
    } finally {
      ownerSocket.disconnect()
      guestSocket.disconnect()
    }
  }, 20000)

  it('leaves everyone else connected', async () => {
    const roomId = await roomWithGuest()
    const ownerClient = collab(roomId, owner.token)
    const guestClient = collab(roomId, guest.token)

    try {
      await waitFor(() => ownerClient.provider.isSynced, { label: 'owner synced' })
      await waitFor(() => guestClient.provider.isSynced, { label: 'guest synced' })

      ownerClient.doc.getText('code').insert(0, 'before')
      await waitFor(() => guestClient.doc.getText('code').toString() === 'before', {
        label: 'seed shared',
      })

      await removeGuest(roomId).expect(200)
      await waitFor(() => !guestClient.provider.isSynced, { label: 'guest cut off' })

      ownerClient.doc.getText('code').insert(6, ' and after')
      await waitFor(() => ownerClient.provider.isSynced, { label: 'owner still synced' })
      expect(guestClient.doc.getText('code').toString()).toBe('before')
    } finally {
      ownerClient.close()
      guestClient.close()
    }
  }, 20000)
})
