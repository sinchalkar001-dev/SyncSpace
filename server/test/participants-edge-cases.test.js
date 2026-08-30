import mongoose from 'mongoose'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { recordParticipant, listPeople } from '../src/services/room.service.js'
import { Participant } from '../src/models/Participant.js'

let app

const ALICE = { email: 'alice@part.test', password: 'correct-horse-battery', name: 'Alice' }

const register = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

const fakeId = () => new mongoose.Types.ObjectId()

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
})

async function makeRoom(token) {
  const res = await request(app)
    .post('/api/v1/rooms')
    .set(auth(token))
    .send({ name: 'Participant test' })
  return res.body.room.roomId
}

describe('recordParticipant edge cases', () => {
  it('returns null when roomId is missing', async () => {
    const result = await recordParticipant({ roomId: null, user: { id: 'x', name: 'X' } })
    expect(result).toBeNull()
  })

  it('returns null when user is missing', async () => {
    const result = await recordParticipant({ roomId: 'some-room', user: null })
    expect(result).toBeNull()
  })

  it('returns null when both are missing', async () => {
    const result = await recordParticipant({ roomId: null, user: null })
    expect(result).toBeNull()
  })

  it('truncates names longer than 64 characters', async () => {
    const { body } = await register(ALICE)
    const roomId = await makeRoom(body.token)
    const longName = 'A'.repeat(100)

    // Use anonymous: true so the user field stays null (no ObjectId needed)
    const result = await recordParticipant({ roomId, user: { name: longName, anonymous: true } })
    expect(result.name).toBe('A'.repeat(64))
    expect(result.name).toHaveLength(64)
  })

  it('handles names at exactly 64 characters without truncation', async () => {
    const { body } = await register(ALICE)
    const roomId = await makeRoom(body.token)
    const exactName = 'B'.repeat(64)

    const result = await recordParticipant({ roomId, user: { name: exactName, anonymous: true } })
    expect(result.name).toBe(exactName)
    expect(result.name).toHaveLength(64)
  })

  it('uses "Guest" as fallback when name is undefined', async () => {
    const { body } = await register(ALICE)
    const roomId = await makeRoom(body.token)

    const result = await recordParticipant({ roomId, user: { anonymous: true } })
    expect(result.name).toBe('Guest')
  })

  it('uses "Guest" as fallback when name is empty string', async () => {
    const { body } = await register(ALICE)
    const roomId = await makeRoom(body.token)

    const result = await recordParticipant({ roomId, user: { name: '', anonymous: true } })
    expect(result.name).toBe('Guest')
  })
})

describe('listPeople edge cases', () => {
  it('returns null owner for a room with no owner (ad-hoc room)', async () => {
    const { body } = await register(ALICE)
    const roomId = await makeRoom(body.token)

    // Simulate an ad-hoc room: no owner and no members
    const { Room } = await import('../src/models/Room.js')
    await Room.findOneAndUpdate({ roomId }, { $set: { owner: null, members: [] } })

    const result = await listPeople(roomId)
    expect(result.owner).toBeNull()
    expect(result.members).toEqual([])
  })

  it('returns participants sorted by lastSeenAt descending', async () => {
    const { body } = await register(ALICE)
    const roomId = await makeRoom(body.token)

    // Use anonymous guests to avoid needing valid ObjectIds
    await recordParticipant({ roomId, user: { id: 'anon-1', name: 'First', anonymous: true } })
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10))
    await recordParticipant({ roomId, user: { id: 'anon-2', name: 'Second', anonymous: true } })

    const result = await listPeople(roomId)
    const names = result.participants.map((p) => p.name)
    expect(names[0]).toBe('Second')
    expect(names[1]).toBe('First')
  })

  it('caps participants list at 100', async () => {
    const { body } = await register(ALICE)
    const roomId = await makeRoom(body.token)

    // Create 110 anonymous participants
    for (let i = 0; i < 110; i++) {
      await recordParticipant({ roomId, user: { id: 'anon-' + i, name: 'User' + i, anonymous: true } })
    }

    const result = await listPeople(roomId)
    expect(result.participants).toHaveLength(100)
  })
})
