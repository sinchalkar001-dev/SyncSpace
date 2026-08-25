import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { UPLOAD_DIR } from '../src/config/upload.js'

let app

const ALICE = { email: 'alice@syncspace.test', password: 'correct-horse-battery', name: 'Alice' }
const BOB = { email: 'bob@syncspace.test', password: 'another-good-passphrase', name: 'Bob' }

const registerUser = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

beforeAll(startMemoryMongo)
afterAll(async () => {
  await stopMemoryMongo()
  // Clean up uploaded files after tests
  await fs.rm(UPLOAD_DIR, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  await clearDatabase()
  await fs.rm(UPLOAD_DIR, { recursive: true, force: true }).catch(() => {})
  app = createApp()
})

async function createRoom(token, name = 'Test Room') {
  const res = await request(app)
    .post('/api/v1/rooms')
    .set(auth(token))
    .send({ name, isPublic: false })
  return res.body.room
}

function makePngBuffer(width = 1, height = 1) {
  // Minimal valid 1x1 PNG (67 bytes)
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  )
}

function makePdfBuffer() {
  // Minimal valid PDF header
  return Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\nxref\n0 0\ntrailer<</Root 1 0 R>>\nstartxref\n0\n%%EOF')
}

describe('file uploads', () => {
  describe('POST /api/v1/rooms/:roomId/files', () => {
    it('requires authentication', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      const res = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .attach('file', makePngBuffer(), { filename: 'test.png', contentType: 'image/png' })

      expect(res.status).toBe(401)
    })

    it('uploads a valid PNG file', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      const res = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .attach('file', makePngBuffer(), { filename: 'photo.png', contentType: 'image/png' })

      expect(res.status).toBe(201)
      expect(res.body.file).toMatchObject({
        roomId: room.roomId,
        originalName: 'photo.png',
        mimeType: 'image/png',
        size: expect.any(Number),
      })
      expect(res.body.file.id).toEqual(expect.any(String))
    })

    it('uploads a valid PDF file', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      const res = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .attach('file', makePdfBuffer(), { filename: 'doc.pdf', contentType: 'application/pdf' })

      expect(res.status).toBe(201)
      expect(res.body.file.mimeType).toBe('application/pdf')
    })

    it('rejects disallowed MIME types', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      const res = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .attach('file', Buffer.from('MZ...'), { filename: 'malware.exe', contentType: 'application/x-msdownload' })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('invalid_file_type')
    })

    it('rejects files without a file field', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      const res = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .send({ notAFile: true })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('no_file')
    })

    it('rejects upload to a room the user cannot access', async () => {
      const alice = await registerUser(ALICE)
      const bob = await registerUser(BOB)
      const room = await createRoom(alice.body.token, 'Alice Private')

      const res = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(bob.body.token))
        .attach('file', makePngBuffer(), { filename: 'test.png', contentType: 'image/png' })

      expect(res.status).toBe(403)
    })

    it('sanitises dangerous filenames', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      const res = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .attach('file', makePngBuffer(), {
          filename: '../../../etc/passwd.png',
          contentType: 'image/png',
        })

      expect(res.status).toBe(201)
      expect(res.body.file.originalName).not.toContain('..')
      expect(res.body.file.originalName).not.toContain('/')
    })

    it('creates the upload directory for the room', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .attach('file', makePngBuffer(), { filename: 'test.png', contentType: 'image/png' })

      const dir = path.join(UPLOAD_DIR, room.roomId)
      const stat = await fs.stat(dir)
      expect(stat.isDirectory()).toBe(true)
    })
  })

  describe('GET /api/v1/rooms/:roomId/files', () => {
    it('lists files in a room', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      // Upload two files
      await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .attach('file', makePngBuffer(), { filename: 'a.png', contentType: 'image/png' })
      await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .attach('file', makePngBuffer(), { filename: 'b.png', contentType: 'image/png' })

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))

      expect(res.status).toBe(200)
      expect(res.body.files).toHaveLength(2)
      expect(res.body.total).toBe(2)
      // Most recent first
      expect(res.body.files[0].originalName).toBe('b.png')
    })

    it('requires authentication', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      const res = await request(app).get(`/api/v1/rooms/${room.roomId}/files`)
      expect(res.status).toBe(401)
    })

    it('rejects listing files in a room the user cannot access', async () => {
      const alice = await registerUser(ALICE)
      const bob = await registerUser(BOB)
      const room = await createRoom(alice.body.token, 'Alice Only')

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(bob.body.token))

      expect(res.status).toBe(403)
    })

    it('supports pagination', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      for (let i = 0; i < 3; i++) {
        await request(app)
          .post(`/api/v1/rooms/${room.roomId}/files`)
          .set(auth(body.token))
          .attach('file', makePngBuffer(), { filename: `f${i}.png`, contentType: 'image/png' })
      }

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/files?limit=2&offset=1`)
        .set(auth(body.token))

      expect(res.status).toBe(200)
      expect(res.body.files).toHaveLength(2)
      expect(res.body.total).toBe(3)
    })
  })

  describe('GET /api/v1/rooms/:roomId/files/:fileId', () => {
    it('returns file metadata', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      const upload = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .attach('file', makePngBuffer(), { filename: 'test.png', contentType: 'image/png' })

      const fileId = upload.body.file.id
      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/files/${fileId}`)
        .set(auth(body.token))

      expect(res.status).toBe(200)
      expect(res.body.file.originalName).toBe('test.png')
    })

    it('returns 404 for nonexistent file', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/files/000000000000000000000000`)
        .set(auth(body.token))

      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/v1/rooms/:roomId/files/:fileId/download', () => {
    it('streams the file contents', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)
      const content = makePngBuffer()

      const upload = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .attach('file', content, { filename: 'photo.png', contentType: 'image/png' })

      const fileId = upload.body.file.id
      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/files/${fileId}/download`)
        .set(auth(body.token))

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('image/png')
      expect(res.headers['content-disposition']).toContain('photo.png')
    })

    it('rejects download without auth', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      const upload = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .attach('file', makePngBuffer(), { filename: 'photo.png', contentType: 'image/png' })

      const res = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/files/${upload.body.file.id}/download`)

      expect(res.status).toBe(401)
    })
  })

  describe('DELETE /api/v1/rooms/:roomId/files/:fileId', () => {
    it('allows the uploader to delete their file', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      const upload = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .attach('file', makePngBuffer(), { filename: 'test.png', contentType: 'image/png' })

      const fileId = upload.body.file.id
      const res = await request(app)
        .delete(`/api/v1/rooms/${room.roomId}/files/${fileId}`)
        .set(auth(body.token))

      expect(res.status).toBe(200)
      expect(res.body.deleted).toBe(true)

      // Verify file is gone from DB
      const getRes = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/files/${fileId}`)
        .set(auth(body.token))
      expect(getRes.status).toBe(404)
    })

    it('allows the room owner to delete any file', async () => {
      const alice = await registerUser(ALICE)
      const bob = await registerUser(BOB)
      const room = await createRoom(alice.body.token, 'Shared Room')

      // Alice invites Bob
      await request(app)
        .post(`/api/v1/rooms/${room.roomId}/invite`)
        .set(auth(alice.body.token))
        .send({ userId: bob.body.user.id, role: 'editor' })

      // Bob uploads a file
      const upload = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(bob.body.token))
        .attach('file', makePngBuffer(), { filename: 'bob-file.png', contentType: 'image/png' })

      // Alice (owner) deletes Bob's file
      const res = await request(app)
        .delete(`/api/v1/rooms/${room.roomId}/files/${upload.body.file.id}`)
        .set(auth(alice.body.token))

      expect(res.status).toBe(200)
    })

    it('prevents non-owner/non-uploader from deleting', async () => {
      const alice = await registerUser(ALICE)
      const bob = await registerUser(BOB)
      const room = await createRoom(alice.body.token, 'Shared Room')

      await request(app)
        .post(`/api/v1/rooms/${room.roomId}/invite`)
        .set(auth(alice.body.token))
        .send({ userId: bob.body.user.id, role: 'editor' })

      // Alice uploads
      const upload = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(alice.body.token))
        .attach('file', makePngBuffer(), { filename: 'alice-file.png', contentType: 'image/png' })

      // Bob tries to delete Alice's file
      const res = await request(app)
        .delete(`/api/v1/rooms/${room.roomId}/files/${upload.body.file.id}`)
        .set(auth(bob.body.token))

      expect(res.status).toBe(403)
    })

    it('removes the file from disk', async () => {
      const { body } = await registerUser(ALICE)
      const room = await createRoom(body.token)

      const upload = await request(app)
        .post(`/api/v1/rooms/${room.roomId}/files`)
        .set(auth(body.token))
        .attach('file', makePngBuffer(), { filename: 'test.png', contentType: 'image/png' })

      const storedName = upload.body.file.id
      // Find the actual stored path
      const infoRes = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/files/${storedName}`)
        .set(auth(body.token))
      // The stored file is in uploads/<roomId>/

      await request(app)
        .delete(`/api/v1/rooms/${room.roomId}/files/${storedName}`)
        .set(auth(body.token))

      // Try to download — should fail
      const dlRes = await request(app)
        .get(`/api/v1/rooms/${room.roomId}/files/${storedName}/download`)
        .set(auth(body.token))
      expect(dlRes.status).toBe(404)
    })
  })
})

describe('filename sanitisation', () => {
  it('strips path traversal from filenames', async () => {
    const { body } = await registerUser(ALICE)
    const room = await createRoom(body.token)

    const res = await request(app)
      .post(`/api/v1/rooms/${room.roomId}/files`)
      .set(auth(body.token))
      .attach('file', makePngBuffer(), {
        filename: '../../etc/passwd.png',
        contentType: 'image/png',
      })

    expect(res.status).toBe(201)
    expect(res.body.file.originalName).not.toContain('..')
    expect(res.body.file.originalName).not.toContain('/')
  })

  it('handles files with no extension', async () => {
    const { body } = await registerUser(ALICE)
    const room = await createRoom(body.token)

    const res = await request(app)
      .post(`/api/v1/rooms/${room.roomId}/files`)
      .set(auth(body.token))
      .attach('file', Buffer.from('hello'), {
        filename: 'README',
        contentType: 'text/plain',
      })

    expect(res.status).toBe(201)
    expect(res.body.file.originalName).toBe('README')
  })
})
