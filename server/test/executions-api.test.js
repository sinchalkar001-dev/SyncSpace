import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo, waitFor } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { env } from '../src/config/env.js'
import { setIo } from '../src/realtime/registry.js'

/**
 * Seeing what has run in a room, and stopping what is still running.
 *
 * Cancellation is the reason a run needs a name before it has finished. The
 * room is told `execution:state` the moment a job is queued, and that message
 * carries the id — without it there is nothing for a Cancel button to address,
 * and the only way out of a slow program is to wait for the timeout.
 */

let app
let sent

const OWNER = { email: 'owner@executions.test', password: 'owner-passphrase-1', name: 'Owner' }
const OTHER = { email: 'other@executions.test', password: 'other-passphrase-1', name: 'Other' }

const register = (who) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

async function makeRoom(token, body = { name: 'Executions' }) {
  const res = await request(app).post('/api/v1/rooms').set(auth(token)).send(body)
  return res.body.room.roomId
}

const run = (roomId, body, token) =>
  request(app).post('/api/v1/rooms/' + roomId + '/run').set(auth(token)).send(body)

const list = (roomId, token, query = '') =>
  request(app).get('/api/v1/rooms/' + roomId + '/executions' + query).set(auth(token))

const one = (roomId, executionId, token) =>
  request(app).get('/api/v1/rooms/' + roomId + '/executions/' + executionId).set(auth(token))

const stop = (roomId, executionId, token) =>
  request(app).delete('/api/v1/rooms/' + roomId + '/executions/' + executionId).set(auth(token))

/** A program that will still be running when the test wants to stop it. */
const SLOW = 'setTimeout(() => console.log("finished on its own"), 8000)'

/**
 * Actually sends the request.
 *
 * Supertest builds a request and only dispatches it when something subscribes,
 * so `const pending = run(...)` on its own starts nothing at all — and a test
 * that then waits for the run to be announced waits forever. Every one of
 * these tests needs the run in flight while it does something else.
 */
const inFlight = (req) => req.then((res) => res)

const original = { timeout: env.RUN_TIMEOUT_MS }

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
  sent = []
  setIo({ to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) })
})

afterEach(() => {
  env.RUN_TIMEOUT_MS = original.timeout
  setIo(null)
})

/** The id the room was told, which is all a client ever has to go on. */
const announcedId = () =>
  sent.find((message) => message.event === 'execution:state' && message.payload.state === 'running')
    ?.payload.executionId

describe('GET /rooms/:roomId/executions', () => {
  it('lists what has run in the room, newest first', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    await run(roomId, { language: 'javascript', code: 'console.log("first")' }, owner.token)
    await run(roomId, { language: 'javascript', code: 'console.log("second")' }, owner.token)

    const res = await list(roomId, owner.token)

    expect(res.status).toBe(200)
    expect(res.body.executions).toHaveLength(2)
    expect(res.body.executions[0].stdout).toBe('second\n')
    expect(res.body.executions[0].state).toBe('completed')
    expect(res.body.executions[0].by.name).toBe('Owner')
  })

  it('records how a run ended, not only that it did', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)
    env.RUN_TIMEOUT_MS = 600

    await run(roomId, { language: 'javascript', code: 'while (true) {}' }, owner.token)

    const [record] = (await list(roomId, owner.token)).body.executions
    expect(record.state).toBe('timed_out')
    expect(record.termination).toBe('timeout')
  })

  it('keeps one room out of another', async () => {
    const owner = (await register(OWNER)).body
    const mine = await makeRoom(owner.token)
    const theirs = await makeRoom(owner.token, { name: 'Other room' })

    await run(mine, { language: 'javascript', code: 'console.log("mine")' }, owner.token)

    expect((await list(theirs, owner.token)).body.executions).toHaveLength(0)
  })

  it('refuses somebody with no access to the room', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = await makeRoom(owner.token, { name: 'Private', isPublic: false })

    const res = await list(roomId, other.token)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('room_forbidden')
  })

  it('is empty rather than absent for a room where nothing has run', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    const res = await list(roomId, owner.token)
    expect(res.status).toBe(200)
    expect(res.body.executions).toEqual([])
  })
})

describe('GET /rooms/:roomId/executions/:executionId', () => {
  it('returns the run the room was told about', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    const posted = await run(roomId, { language: 'javascript', code: 'console.log("hi")' }, owner.token)
    const res = await one(roomId, posted.body.run.executionId, owner.token)

    expect(res.status).toBe(200)
    expect(res.body.execution.stdout).toBe('hi\n')
  })

  /** An id from another room is not this room's to read. */
  it('will not read a run across rooms', async () => {
    const owner = (await register(OWNER)).body
    const mine = await makeRoom(owner.token)
    const theirs = await makeRoom(owner.token, { name: 'Other room' })

    const posted = await run(mine, { language: 'javascript', code: 'console.log(1)' }, owner.token)

    const res = await one(theirs, posted.body.run.executionId, owner.token)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('execution_not_found')
  })

  it('says not found for an id that never existed', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    const res = await one(roomId, '11111111-2222-3333-4444-555555555555', owner.token)
    expect(res.status).toBe(404)
  })
})

describe('DELETE /rooms/:roomId/executions/:executionId', () => {
  it('stops a program that is still running', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)
    env.RUN_TIMEOUT_MS = 15000

    const pending = inFlight(run(roomId, { language: 'javascript', code: SLOW }, owner.token))
    const executionId = await waitFor(announcedId, { label: 'the run to be announced' })

    const res = await stop(roomId, executionId, owner.token)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ cancelled: true, state: 'cancelled' })

    // The request that started it comes back rather than hanging until the
    // timeout, and says how it ended.
    const finished = await pending
    expect(finished.body.run.state).toBe('cancelled')
    expect(finished.body.run.stdout).not.toContain('finished on its own')
  }, 30000)

  it('tells the room it was cancelled', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)
    env.RUN_TIMEOUT_MS = 15000

    const pending = inFlight(run(roomId, { language: 'javascript', code: SLOW }, owner.token))
    const executionId = await waitFor(announcedId, { label: 'the run to be announced' })
    await stop(roomId, executionId, owner.token)
    await pending

    const states = sent
      .filter((message) => message.event === 'execution:state')
      .map((message) => message.payload.state)

    expect(states).toContain('cancelled')
  }, 30000)

  /**
   * A shared console must not become a shared stop button: anyone in the room
   * could otherwise end anyone else's work.
   */
  it('will not let another member stop somebody else’s run', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = await makeRoom(owner.token, { isPublic: true })
    env.RUN_TIMEOUT_MS = 15000

    const pending = inFlight(run(roomId, { language: 'javascript', code: SLOW }, owner.token))
    const executionId = await waitFor(announcedId, { label: 'the run to be announced' })

    const res = await stop(roomId, executionId, other.token)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('execution_forbidden')

    // And it really did keep running.
    await stop(roomId, executionId, owner.token)
    await pending
  }, 30000)

  /** Somebody has to be able to end a run in their own room. */
  it('lets the room owner stop a run they did not start', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = await makeRoom(owner.token, { isPublic: true })
    env.RUN_TIMEOUT_MS = 15000

    const pending = inFlight(run(roomId, { language: 'javascript', code: SLOW }, other.token))
    const executionId = await waitFor(announcedId, { label: 'the run to be announced' })

    const res = await stop(roomId, executionId, owner.token)
    expect(res.body).toEqual({ cancelled: true, state: 'cancelled' })

    await pending
  }, 30000)

  it('answers a late cancel with its final state rather than an error', async () => {
    const owner = (await register(OWNER)).body
    const roomId = await makeRoom(owner.token)

    const posted = await run(roomId, { language: 'javascript', code: 'console.log(1)' }, owner.token)

    // Pressing Cancel as a program exits is a race, not a mistake.
    const res = await stop(roomId, posted.body.run.executionId, owner.token)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ cancelled: false, state: 'completed' })
  })

  it('refuses somebody with no access to the room at all', async () => {
    const owner = (await register(OWNER)).body
    const other = (await register(OTHER)).body
    const roomId = await makeRoom(owner.token, { name: 'Private', isPublic: false })

    const posted = await run(roomId, { language: 'javascript', code: 'console.log(1)' }, owner.token)

    const res = await stop(roomId, posted.body.run.executionId, other.token)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('room_forbidden')
  })
})

describe('what /runners says about isolation', () => {
  it('reports the backend and what it does not enforce', async () => {
    const res = await request(app).get('/api/v1/runners')

    expect(res.status).toBe(200)
    expect(['docker', 'process']).toContain(res.body.isolation.backend)
    expect(typeof res.body.isolation.weak).toBe('boolean')
    expect(Array.isArray(res.body.isolation.unenforced)).toBe(true)
    expect(res.body.isolation.limits.timeoutMs).toBeGreaterThan(0)
  })

  it('says nothing about isolation when execution is switched off', async () => {
    env.ALLOW_CODE_EXECUTION = false
    try {
      const res = await request(app).get('/api/v1/runners')
      expect(res.body.enabled).toBe(false)
      expect(res.body.isolation).toBeNull()
    } finally {
      env.ALLOW_CODE_EXECUTION = true
    }
  })
})
