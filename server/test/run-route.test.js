import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { env } from '../src/config/env.js'
import { setIo } from '../src/realtime/registry.js'

let app

const OWNER = { email: 'runner@syncspace.test', password: 'owner-passphrase-1', name: 'Owner' }
const OTHER = { email: 'stranger@syncspace.test', password: 'other-passphrase-1', name: 'Other' }

const register = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

async function makeRoom(token, body = { name: 'Runner' }) {
  const res = await request(app).post('/api/v1/rooms').set(auth(token)).send(body)
  return res.body.room.roomId
}

const run = (roomId, body, token) => {
  const call = request(app).post('/api/v1/rooms/' + roomId + '/run')
  return token ? call.set(auth(token)).send(body) : call.send(body)
}

const enabled = env.ALLOW_CODE_EXECUTION

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
})

afterEach(() => {
  env.ALLOW_CODE_EXECUTION = enabled
  setIo(null)
})

describe('POST /rooms/:roomId/run', () => {
  it('runs the code and answers with what it printed', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    const res = await run(roomId, { language: 'javascript', code: 'console.log(6 * 7)' }, owner.token)

    expect(res.status).toBe(200)
    expect(res.body.run.stdout).toBe('42\n')
    expect(res.body.run.exitCode).toBe(0)
    expect(res.body.run.ok).toBe(true)
  })

  it('passes stdin through to the program', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    const code = [
      'let input = ""',
      'process.stdin.on("data", (c) => { input += c })',
      'process.stdin.on("end", () => console.log("read " + input.trim()))',
    ].join('\n')

    const res = await run(roomId, { language: 'javascript', code, stdin: 'seven' }, owner.token)
    expect(res.body.run.stdout).toBe('read seven\n')
  })

  it('keeps a private room private', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = await makeRoom(owner.token, { name: 'Private', isPublic: false })

    const res = await run(roomId, { language: 'javascript', code: 'console.log(1)' }, other.token)

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('room_forbidden')
  })

  it('rejects a body that is not a program', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    const res = await run(roomId, { language: 'javascript' }, owner.token)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('explains that a language has no runner rather than failing obscurely', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    const res = await run(roomId, { language: 'markdown', code: '# hello' }, owner.token)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('language_not_runnable')
    expect(res.body.error.message).toContain('markdown')
  })

  it('refuses every run when execution is switched off', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)
    env.ALLOW_CODE_EXECUTION = false

    const res = await run(roomId, { language: 'javascript', code: 'console.log(1)' }, owner.token)

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('execution_disabled')
  })

  it('tells the room what ran, not only whoever pressed Run', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    const sent = []
    setIo({ to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) })

    await run(roomId, { language: 'javascript', code: 'console.log("shared")' }, owner.token)

    expect(sent).toHaveLength(1)
    expect(sent[0].room).toBe(roomId)
    expect(sent[0].event).toBe('code:run')
    expect(sent[0].payload.by.name).toBe('Owner')
    expect(sent[0].payload.run.stdout).toBe('shared\n')
  })

  it('runs in a room that only exists because someone opened the URL', async () => {
    const owner = (await register(OWNER)).body

    // No POST /rooms first: this is the ad-hoc path, where the room record is
    // created by the collab document, not by the dashboard.
    const res = await run(
      'typed-into-the-address-bar',
      { language: 'javascript', code: 'console.log("new room")' },
      owner.token
    )

    expect(res.status).toBe(200)
    expect(res.body.run.stdout).toBe('new room\n')
  })

  it('answers even with no socket server registered', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)
    setIo(null)

    const res = await run(roomId, { language: 'javascript', code: 'console.log(1)' }, owner.token)
    expect(res.status).toBe(200)
  })
})

describe('GET /runners', () => {
  it('lists what this machine can run', async () => {
    const res = await request(app).get('/api/v1/runners')

    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(true)
    expect(res.body.timeoutMs).toBeGreaterThan(0)

    const javascript = res.body.languages.find((entry) => entry.language === 'javascript')
    expect(javascript.available).toBe(true)
  })

  it('reports nothing runnable when execution is off', async () => {
    env.ALLOW_CODE_EXECUTION = false

    const res = await request(app).get('/api/v1/runners')

    expect(res.body.enabled).toBe(false)
    expect(res.body.languages).toEqual([])
  })
})
