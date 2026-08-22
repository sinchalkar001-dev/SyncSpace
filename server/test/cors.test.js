import request from 'supertest'
import { WebSocket } from 'ws'
import { io as ioClient } from 'socket.io-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { startServer } from '../src/index.js'

const ALLOWED = 'http://localhost:5173'
const BLOCKED = 'http://evil.example'

let server

beforeAll(async () => {
  await startMemoryMongo()
  server = await startServer({ port: 0, host: '127.0.0.1', connectDb: false })
}, 120000)

afterAll(async () => {
  await server.close()
  await stopMemoryMongo()
})

describe('CORS policy on the REST API', () => {
  it('answers preflights from allowlisted origins with CORS headers', async () => {
    const res = await request(server.app)
      .options('/api/v1/auth/register')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')

    expect(res.status).toBeLessThan(400)
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('withholds CORS headers from unknown origins', async () => {
    const res = await request(server.app)
      .post('/api/v1/auth/register')
      .set('Origin', BLOCKED)
      .set('Access-Control-Request-Method', 'POST')

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('still serves requests without an Origin header (same-origin, curl)', async () => {
    const res = await request(server.app).get('/health')
    expect(res.status).toBe(200)
  })
})

describe('origin policy on WebSocket upgrades', () => {
  const wsUrl = () => 'ws://127.0.0.1:' + server.port + '/collab'

  function openCollab(origin) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl(), { headers: origin ? { origin } : {} })
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }

  it('accepts allowlisted browser origins', async () => {
    const ws = await openCollab(ALLOWED)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('accepts handshakes without an Origin header (non-browser client)', async () => {
    const ws = await openCollab(null)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('rejects unknown origins with 403 before any sync traffic flows', async () => {
    await expect(openCollab(BLOCKED)).rejects.toThrow(/403/)
  })

  it('keeps Socket.io connections working alongside the collab check', async () => {
    const socket = ioClient('http://127.0.0.1:' + server.port, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
    })

    await new Promise((resolve, reject) => {
      socket.on('connect', resolve)
      socket.on('connect_error', reject)
    })
    socket.disconnect()
  })
})
