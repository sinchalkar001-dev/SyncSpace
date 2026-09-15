import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { UPLOAD_DIR } from '../src/config/upload.js'
import { ensureRoom } from '../src/services/room.service.js'

/**
 * Where a room's files are allowed to land on disk.
 *
 * A room id is typed, not issued: opening any code creates a public room under
 * it, and nothing restricts the characters. The upload directory is built from
 * that id, so the id is the thing to distrust.
 */

let app

const ALICE = { email: 'alice@paths.test', password: 'correct-horse-battery', name: 'Alice' }
const auth = (token) => ({ Authorization: 'Bearer ' + token })

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
})

const signIn = async () => (await request(app).post('/api/v1/auth/register').send(ALICE)).body.token

const upload = (token, roomId) =>
  request(app)
    .post('/api/v1/rooms/' + encodeURIComponent(roomId) + '/files')
    .set(auth(token))
    .attach('file', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/plain' })

describe('a room id that is not a plain name', () => {
  it('cannot walk an upload out of the upload directory', async () => {
    const escaped = 'syncspace-escape-' + Date.now()
    const roomId = 'x/../../' + escaped
    const outside = path.resolve(UPLOAD_DIR, '..', escaped)

    try {
      const token = await signIn()
      await ensureRoom(roomId)

      const res = await upload(token, roomId)

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('invalid_room_id')
      await expect(fs.access(outside)).rejects.toThrow()
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('still stores files for an ordinary room', async () => {
    const token = await signIn()
    const room = await ensureRoom('plain-room-' + Date.now())

    const res = await upload(token, room.roomId)
    expect(res.status).toBe(201)

    await fs.rm(path.join(UPLOAD_DIR, room.roomId), { recursive: true, force: true })
  })
})

describe('listing a page of files', () => {
  it('treats a negative offset as the first page rather than failing', async () => {
    const token = await signIn()
    const room = await ensureRoom('paging-room-' + Date.now())

    const res = await request(app)
      .get('/api/v1/rooms/' + room.roomId + '/files?offset=-5&limit=-1')
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ files: [], offset: 0, limit: 1 })
  })
})
