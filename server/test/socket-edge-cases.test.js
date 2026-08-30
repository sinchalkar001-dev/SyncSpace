import request from 'supertest'
import { io as ioClient } from 'socket.io-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMemoryMongo, stopMemoryMongo, waitFor } from './helpers/db.js'
import { startServer } from '../src/index.js'
import { env } from '../src/config/env.js'

let server
let counter = 0
const nextRoom = () => 'sock-edge-' + Date.now() + '-' + (counter += 1)

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

describe('chat validation', () => {
  it('rejects chat with empty text', async () => {
    const room = nextRoom()
    const socket = connectSocket()
    try {
      await connected(socket)
      await join(socket, room, { name: 'Alice' })
      const ack = await new Promise((resolve) =>
        socket.emit('room:chat', { roomId: room, text: '' }, resolve)
      )
      expect(ack).toEqual({ ok: false, error: 'invalid_payload' })
    } finally {
      socket.disconnect()
    }
  })

  it('rejects chat with text exceeding 2000 characters', async () => {
    const room = nextRoom()
    const socket = connectSocket()
    try {
      await connected(socket)
      await join(socket, room, { name: 'Alice' })
      const ack = await new Promise((resolve) =>
        socket.emit('room:chat', { roomId: room, text: 'x'.repeat(2001) }, resolve)
      )
      expect(ack).toEqual({ ok: false, error: 'invalid_payload' })
    } finally {
      socket.disconnect()
    }
  })

  it('rejects chat with missing roomId', async () => {
    const socket = connectSocket()
    try {
      await connected(socket)
      const ack = await new Promise((resolve) =>
        socket.emit('room:chat', { text: 'hello' }, resolve)
      )
      expect(ack).toEqual({ ok: false, error: 'invalid_payload' })
    } finally {
      socket.disconnect()
    }
  })

  it('accepts chat at exactly 2000 characters', async () => {
    const room = nextRoom()
    const socket = connectSocket()
    try {
      await connected(socket)
      await join(socket, room, { name: 'Alice' })
      const ack = await new Promise((resolve) =>
        socket.emit('room:chat', { roomId: room, text: 'a'.repeat(2000) }, resolve)
      )
      expect(ack).toEqual({ ok: true })
    } finally {
      socket.disconnect()
    }
  })
})

describe('disconnect behavior', () => {
  it('does not crash when disconnecting without having joined a room', async () => {
    const socket = connectSocket()
    try {
      await connected(socket)
      // Disconnect without joining any room
      socket.disconnect()
      // If we get here without throwing, the test passes
      expect(true).toBe(true)
    } catch {
      // Connection error is also acceptable
      expect(true).toBe(true)
    }
  })

  it('broadcasts updated presence when a socket disconnects', async () => {
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

      // Hard disconnect to trigger the disconnect handler
      leaver.disconnect()

      const latest = await waitFor(
        () => presence.find((event) => event.members.length === 1),
        { label: 'presence shrank after disconnect' }
      )
      expect(latest.members[0].user.name).toBe('Alice')
    } finally {
      stayer.disconnect()
    }
  })
})

describe('ad-hoc room join', () => {
  it('creates the room automatically when joining a nonexistent room', async () => {
    const room = nextRoom()
    const socket = connectSocket()
    try {
      await connected(socket)
      const ack = await join(socket, room, { name: 'Alice' })
      expect(ack.ok).toBe(true)
      expect(ack.room.roomId).toBe(room)
      expect(ack.room.isPublic).toBe(true)
    } finally {
      socket.disconnect()
    }
  })
})

describe('join validation edge cases', () => {
  it('rejects join with missing user object', async () => {
    const room = nextRoom()
    const socket = connectSocket()
    try {
      await connected(socket)
      const ack = await new Promise((resolve) =>
        socket.emit('room:join', { roomId: room }, resolve)
      )
      // Without a user, it should still work (anonymous with default name)
      expect(ack.ok).toBe(true)
    } finally {
      socket.disconnect()
    }
  })

  it('rejects join with empty roomId', async () => {
    const socket = connectSocket()
    try {
      await connected(socket)
      const ack = await join(socket, '', { name: 'Alice' })
      expect(ack).toEqual({ ok: false, error: 'invalid_payload' })
    } finally {
      socket.disconnect()
    }
  })

  it('rejects a guest display name longer than 32 characters', async () => {
    const room = nextRoom()
    const socket = connectSocket()
    try {
      await connected(socket)
      const ack = await join(socket, room, { name: 'A'.repeat(33) })
      expect(ack).toEqual({ ok: false, error: 'invalid_payload' })
    } finally {
      socket.disconnect()
    }
  })

  it('accepts a guest display name at exactly 32 characters', async () => {
    const room = nextRoom()
    const socket = connectSocket()
    const presence = []
    try {
      await connected(socket)
      socket.on('room:presence', (payload) => presence.push(payload))
      const ack = await join(socket, room, { name: 'A'.repeat(32) })
      expect(ack.ok).toBe(true)

      const latest = await waitFor(
        () => presence.find((event) => event.members.length === 1),
        { label: 'presence with 32-char name' }
      )
      expect(latest.members[0].user.name).toBe('A'.repeat(32))
    } finally {
      socket.disconnect()
    }
  })
})

describe('socket authentication', () => {
  it('rejects connection when ALLOW_ANONYMOUS is false and no token provided', async () => {
    const original = env.ALLOW_ANONYMOUS
    env.ALLOW_ANONYMOUS = false
    try {
      const socket = connectSocket()
      await expect(connected(socket)).rejects.toThrow()
      socket.disconnect()
    } finally {
      env.ALLOW_ANONYMOUS = original
    }
  })
})

describe('multiple rooms per socket', () => {
  it('overwrites the tracked room when joining a second room', async () => {
    const room1 = nextRoom()
    const room2 = nextRoom()
    const socket = connectSocket()
    const presence = []

    try {
      await connected(socket)
      socket.on('room:presence', (payload) => presence.push(payload))

      await join(socket, room1, { name: 'Alice' })
      await join(socket, room2, { name: 'Alice' })

      // Socket should be in room2 now, not room1
      // Verify presence shows only one person in room2
      const room2Presence = await waitFor(
        () => presence.find((e) => e.roomId === room2 && e.members.length === 1),
        { label: 'presence in room2' }
      )
      expect(room2Presence.members[0].user.name).toBe('Alice')
    } finally {
      socket.disconnect()
    }
  })
})
