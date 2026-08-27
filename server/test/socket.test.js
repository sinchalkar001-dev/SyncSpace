import request from 'supertest'
import { io as ioClient } from 'socket.io-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMemoryMongo, stopMemoryMongo, waitFor } from './helpers/db.js'
import { startServer } from '../src/index.js'
import { Room } from '../src/models/Room.js'

let server
let counter = 0
const nextRoom = () => 'sock-' + Date.now() + '-' + (counter += 1)

function connectSocket(auth = {}) {
  return ioClient('http://127.0.0.1:' + server.port, {
    path: '/socket.io',
    transports: ['websocket'],
    auth,
    reconnection: false,
  })
}

const connected = (socket) =>
  new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket))
    socket.on('connect_error', reject)
  })

const join = (socket, roomId, user) =>
  new Promise((resolve) => socket.emit('room:join', { roomId, user }, resolve))

beforeAll(async () => {
  await startMemoryMongo()
  server = await startServer({ port: 0, host: '127.0.0.1', connectDb: false })
}, 120000)

afterAll(async () => {
  await server.close()
  await stopMemoryMongo()
})

describe('socket.io room lifecycle', () => {
  it('shares the HTTP server with the collab endpoint', async () => {
    const socket = connectSocket()
    try {
      await connected(socket)
      expect(socket.connected).toBe(true)
    } finally {
      socket.disconnect()
    }
  })

  it('acknowledges a join and broadcasts presence to the room', async () => {
    const room = nextRoom()
    const first = connectSocket()
    const second = connectSocket()

    const presence = []

    try {
      await connected(first)
      await connected(second)
      first.on('room:presence', (payload) => presence.push(payload))

      const ackOne = await join(first, room, { name: 'Alice' })
      expect(ackOne.ok).toBe(true)
      expect(ackOne.room.roomId).toBe(room)

      const ackTwo = await join(second, room, { name: 'Bob' })
      expect(ackTwo.ok).toBe(true)

      const latest = await waitFor(
        () => presence.find((event) => event.members.length === 2),
        { label: 'two members present' }
      )
      expect(latest.roomId).toBe(room)
      expect(latest.members.map((m) => m.user.name).sort()).toEqual(['Alice', 'Bob'])
    } finally {
      first.disconnect()
      second.disconnect()
    }
  })

  it('relays chat to everyone in the room', async () => {
    const room = nextRoom()
    const sender = connectSocket()
    const listener = connectSocket()
    const messages = []

    try {
      await connected(sender)
      await connected(listener)
      listener.on('room:chat', (payload) => messages.push(payload))

      await join(sender, room, { name: 'Alice' })
      await join(listener, room, { name: 'Bob' })

      const ack = await new Promise((resolve) =>
        sender.emit('room:chat', { roomId: room, text: 'ready when you are' }, resolve)
      )
      expect(ack.ok).toBe(true)

      const received = await waitFor(() => messages[0], { label: 'chat delivered' })
      expect(received.text).toBe('ready when you are')
      expect(received.from.name).toBe('Alice')
    } finally {
      sender.disconnect()
      listener.disconnect()
    }
  })

  it('rejects chat from outside the room', async () => {
    const socket = connectSocket()
    try {
      await connected(socket)
      const ack = await new Promise((resolve) =>
        socket.emit('room:chat', { roomId: nextRoom(), text: 'hello' }, resolve)
      )
      expect(ack).toEqual({ ok: false, error: 'not_in_room' })
    } finally {
      socket.disconnect()
    }
  })

  it('validates the join payload', async () => {
    const socket = connectSocket()
    try {
      await connected(socket)
      const ack = await join(socket, '')
      expect(ack).toEqual({ ok: false, error: 'invalid_payload' })
    } finally {
      socket.disconnect()
    }
  })

  it('refuses an anonymous join to a private room', async () => {
    const room = nextRoom()
    await Room.create({ roomId: room, name: 'Private', isPublic: false })

    const socket = connectSocket()
    try {
      await connected(socket)
      const ack = await join(socket, room, { name: 'Stranger' })
      expect(ack).toEqual({ ok: false, error: 'forbidden' })
    } finally {
      socket.disconnect()
    }
  })

  it('keeps the token identity over a claimed name', async () => {
    const room = nextRoom()
    const { issueToken } = await import('../src/services/auth.service.js')
    const token = issueToken({ id: '507f1f77bcf86cd799439011', name: 'Real Name' })

    const socket = connectSocket({ token })
    const presence = []

    try {
      await connected(socket)
      // Presence is emitted before the join ack resolves, so subscribe first.
      socket.on('room:presence', (payload) => presence.push(payload))

      const ack = await join(socket, room, { name: 'Impostor' })
      expect(ack.ok).toBe(true)

      const roster = await waitFor(() => presence[0], { label: 'presence for token user' })
      expect(roster.members[0].user.name).toBe('Real Name')
      expect(roster.members[0].user.anonymous).toBe(false)
    } finally {
      socket.disconnect()
    }
  })

  it('updates presence when a member leaves', async () => {
    const room = nextRoom()
    const stayer = connectSocket()
    const leaver = connectSocket()
    const presence = []

    try {
      await connected(stayer)
      await connected(leaver)

      await join(stayer, room, { name: 'Alice' })
      await join(leaver, room, { name: 'Bob' })

      stayer.on('room:presence', (payload) => presence.push(payload))
      leaver.emit('room:leave', { roomId: room })

      const latest = await waitFor(
        () => presence.find((event) => event.members.length === 1),
        { label: 'presence shrank to one' }
      )
      expect(latest.members[0].user.name).toBe('Alice')
    } finally {
      stayer.disconnect()
      leaver.disconnect()
    }
  })
})

const OWNER = { email: 'sock-owner@test.com', password: 'pass-1234', name: 'Owner' }
const MEMBER = { email: 'sock-member@test.com', password: 'pass-5678', name: 'Member' }

const auth = (token) => ({ Authorization: 'Bearer ' + token })

async function register(user) {
  const res = await request(server.app).post('/api/v1/auth/register').send(user)
  if (res.status !== 201) throw new Error('register failed: ' + res.status + ' ' + JSON.stringify(res.body))
  return res.body
}

async function createRoom(token, overrides = {}) {
  const res = await request(server.app)
    .post('/api/v1/rooms')
    .set(auth(token))
    .send({ name: 'Auth test room', ...overrides })
  if (res.status !== 201) throw new Error('createRoom failed: ' + res.status + ' ' + JSON.stringify(res.body))
  return res.body.room
}

async function patchRoom(token, roomId, patch) {
  return request(server.app).patch('/api/v1/rooms/' + roomId).set(auth(token)).send(patch)
}

async function deleteRoom(token, roomId) {
  return request(server.app).delete('/api/v1/rooms/' + roomId).set(auth(token))
}

describe('room authorization on visibility change', () => {
  it('kicks non-member socket users when room goes private', async () => {
    const owner = await register(OWNER)
    const room = await createRoom(owner.token, { isPublic: true })

    const stranger = connectSocket()
    const kicked = []

    try {
      await connected(stranger)
      stranger.on('room:kicked', (payload) => kicked.push(payload))

      const ack = await join(stranger, room.roomId, { name: 'Stranger' })
      expect(ack.ok).toBe(true)

      await patchRoom(owner.token, room.roomId, { isPublic: false })

      const event = await waitFor(() => kicked[0], { label: 'stranger kicked' })
      expect(event.reason).toBe('room_became_private')
      expect(event.roomId).toBe(room.roomId)
    } finally {
      stranger.disconnect()
    }
  })

  it('keeps member socket users connected when room goes private', async () => {
    const owner = await register({ email: 'sock-owner2@test.com', password: 'pass-1234', name: 'Owner' })
    const member = await register({ email: 'sock-member2@test.com', password: 'pass-5678', name: 'Member' })
    const room = await createRoom(owner.token, { isPublic: true })

    await request(server.app)
      .post('/api/v1/rooms/' + room.roomId + '/invite')
      .set(auth(owner.token))
      .send({ userId: member.user.id })
      .expect(200)

    const memberSocket = connectSocket({ token: member.token })
    const kicked = []

    try {
      await connected(memberSocket)
      memberSocket.on('room:kicked', (payload) => kicked.push(payload))

      const ack = await join(memberSocket, room.roomId)
      expect(ack.ok).toBe(true)

      await patchRoom(owner.token, room.roomId, { isPublic: false })

      // Wait briefly to ensure no kick event arrives
      await new Promise((r) => setTimeout(r, 200))
      expect(kicked).toHaveLength(0)
    } finally {
      memberSocket.disconnect()
    }
  })

  it('disconnects socket users when room is deleted', async () => {
    const owner = await register({ email: 'sock-owner3@test.com', password: 'pass-1234', name: 'Owner' })
    const room = await createRoom(owner.token, { isPublic: true })

    const visitor = connectSocket()
    const kicked = []

    try {
      await connected(visitor)
      visitor.on('room:kicked', (payload) => kicked.push(payload))

      const ack = await join(visitor, room.roomId, { name: 'Visitor' })
      expect(ack.ok).toBe(true)

      await deleteRoom(owner.token, room.roomId)

      const event = await waitFor(() => kicked[0], { label: 'visitor kicked on delete' })
      expect(event.reason).toBe('room_deleted')
      expect(event.roomId).toBe(room.roomId)
    } finally {
      visitor.disconnect()
    }
  })
})
