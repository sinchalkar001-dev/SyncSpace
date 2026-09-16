import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The Redis client library, and when the server pays for loading it.
 *
 * It is among the heaviest modules the server imports, and a server with no
 * REDIS_URL — every development machine — never uses it. So it must be loaded
 * when a client is first wanted, not whenever the rate limiter is imported.
 *
 * Every module is imported inside the test, after the mock is in place and on
 * a fresh module registry, so each test sees its own `env` and its own client.
 */

afterEach(() => {
  vi.doUnmock('redis')
  vi.resetModules()
})

/** Stands in for the library, recording whether anything loaded it. */
function fakeRedis() {
  const seen = { loaded: false }
  vi.doMock('redis', () => {
    seen.loaded = true
    return {
      createClient: () => ({ on: () => {}, connect: async () => {} }),
    }
  })
  return seen
}

async function withRedisUrl(url) {
  const { env } = await import('../src/config/env.js')
  env.REDIS_URL = url
}

describe('the redis client library', () => {
  it('is not loaded just because the server starts', async () => {
    const seen = fakeRedis()
    await withRedisUrl(undefined)

    const { initRateLimitStore } = await import('../src/middleware/rateLimit.js')
    await initRateLimitStore()

    expect(seen.loaded).toBe(false)
  })

  it('is loaded when a Redis URL is configured and a client is asked for', async () => {
    const seen = fakeRedis()
    await withRedisUrl('redis://127.0.0.1:6379')

    const { getRedisClient } = await import('../src/config/redis.js')
    const client = await getRedisClient()

    expect(seen.loaded).toBe(true)
    expect(client).not.toBeNull()
  })
})
