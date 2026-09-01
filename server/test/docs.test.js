import request from 'supertest'
import express from 'express'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadEnv } from '../src/config/env.js'
import { mountDocs } from '../src/docs/docs.routes.js'
import { notFoundHandler } from '../src/middleware/error.js'

let app

beforeAll(() => {
  // No database: the documentation routes never touch one.
  app = createApp()
})

const documentedPaths = [
  '/health',
  '/api/v1/auth/change-password',
  '/api/v1/auth/login',
  '/api/v1/auth/me',
  '/api/v1/auth/register',
  '/api/v1/auth/resend-verification',
  '/api/v1/auth/verify-email',
  '/api/v1/rooms',
  '/api/v1/rooms/{roomId}',
  '/api/v1/rooms/{roomId}/blocked/{userId}',
  '/api/v1/rooms/{roomId}/invite',
  '/api/v1/rooms/{roomId}/invites/{email}',
  '/api/v1/rooms/{roomId}/members/{userId}',
  '/api/v1/rooms/{roomId}/people',
  '/api/v1/rooms/{roomId}/replay',
  '/api/v1/rooms/{roomId}/replay/{seq}',
  '/api/v1/rooms/{roomId}/run',
  '/api/v1/runners',
]

/** A minimal host app, so placement and disabling can be tested in isolation. */
function appWith(options) {
  const hosted = express()
  hosted.use(express.json({ limit: '256kb' }))
  mountDocs(hosted, options)
  hosted.use(notFoundHandler)
  return hosted
}

describe('Swagger UI endpoint', () => {
  it('serves the OpenAPI document as JSON', async () => {
    const res = await request(app).get('/docs/openapi.json')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body.openapi).toMatch(/^3\.0\.\d+$/)
    expect(res.body.info.title).toBe('SyncSpace API')
  })

  it('documents exactly the REST surface that exists', async () => {
    const res = await request(app).get('/docs/openapi.json')
    expect(Object.keys(res.body.paths).sort()).toEqual([...documentedPaths].sort())
  })

  it('covers every documented group', async () => {
    const res = await request(app).get('/docs/openapi.json')
    const tagNames = new Set(res.body.tags.map((tag) => tag.name))
    for (const name of ['Auth', 'Users', 'Rooms', 'Invitations', 'Replay']) {
      expect(tagNames.has(name)).toBe(true)
    }
  })

  it('renders the interactive UI', async () => {
    const res = await request(app).get('/docs/')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.text).toContain('swagger-ui-bundle.js')
    expect(res.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'")
  })

  it('redirects the bare path so relative assets resolve', async () => {
    const res = await request(app).get('/docs')
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/docs/')
  })

  it('serves its scripts from the same endpoint', async () => {
    const init = await request(app).get('/docs/swagger-ui-init.js')
    expect(init.status).toBe(200)
    expect(init.headers['content-type']).toMatch(/javascript/)
    expect(init.text).toContain('persistAuthorization')

    const css = await request(app).get('/docs/swagger-ui.css')
    expect(css.status).toBe(200)
  })

  it('keeps the strict API CSP everywhere else', async () => {
    const health = await request(app).get('/health')
    // helmet's own policy keeps frame-ancestors 'self'; only the docs mount
    // overrides it with 'none'. Its absence here proves the override is local.
    expect(health.headers['content-security-policy']).toContain("frame-ancestors 'self'")
    expect(health.headers['content-security-policy']).not.toContain("style-src 'self' 'unsafe-inline'")
  })

  it('leaks the document nowhere else', async () => {
    expect((await request(app).get('/openapi.json')).status).toBe(404)
    expect((await request(app).get('/api/v1/openapi.json')).status).toBe(404)
  })
})

describe('documentation placement', () => {
  it('defaults to enabled at /docs', () => {
    const env = loadEnv({})
    expect(env.SWAGGER_ENABLED).toBe(true)
    expect(env.SWAGGER_PATH).toBe('/docs')
  })

  it('coerces the switch like other booleanish settings', () => {
    expect(loadEnv({ SWAGGER_ENABLED: '0' }).SWAGGER_ENABLED).toBe(false)
    expect(loadEnv({ SWAGGER_ENABLED: 'true' }).SWAGGER_ENABLED).toBe(true)
  })

  it('trims trailing slashes off the path', () => {
    expect(loadEnv({ SWAGGER_PATH: '/api-docs/' }).SWAGGER_PATH).toBe('/api-docs')
  })

  it('rejects paths without a leading slash or with whitespace', () => {
    expect(() => loadEnv({ SWAGGER_PATH: 'docs' })).toThrow(/single "\/"/)
    expect(() => loadEnv({ SWAGGER_PATH: '/' })).toThrow(/single "\/"/)
    expect(() => loadEnv({ SWAGGER_PATH: '/my docs' })).toThrow(/whitespace/)
  })

  it('refuses to shadow reserved routes', () => {
    expect(() => loadEnv({ SWAGGER_PATH: '/api' })).toThrow(/reserved/)
    expect(() => loadEnv({ SWAGGER_PATH: '/health' })).toThrow(/reserved/)
    expect(() => loadEnv({ SWAGGER_PATH: '/collab' })).toThrow(/reserved/)
    expect(() => loadEnv({ SWAGGER_PATH: '/socket.io' })).toThrow(/reserved/)
  })
})

describe('mountDocs options', () => {
  it('honours a custom path', async () => {
    const hosted = appWith({ enabled: true, path: '/api-docs' })
    expect((await request(hosted).get('/api-docs/')).status).toBe(200)
    expect((await request(hosted).get('/docs')).status).toBe(404)
  })

  it('removes every trace when disabled', async () => {
    const hosted = appWith({ enabled: false })
    expect((await request(hosted).get('/docs')).status).toBe(404)
    expect((await request(hosted).get('/docs/openapi.json')).status).toBe(404)
  })
})
