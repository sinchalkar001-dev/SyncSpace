import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/config/env.js'

const PROD_SECRET = 'x'.repeat(40)

describe('environment validation', () => {
  it('applies defaults for an empty environment', () => {
    const env = loadEnv({})
    expect(env.NODE_ENV).toBe('development')
    expect(env.PORT).toBe(4000)
    expect(env.ALLOW_ANONYMOUS).toBe(true)
    expect(env.CORS_ORIGIN).toEqual(['http://localhost:5173'])
  })

  it('splits CORS_ORIGIN into a list', () => {
    const env = loadEnv({ CORS_ORIGIN: 'http://a.test, http://b.test' })
    expect(env.CORS_ORIGIN).toEqual(['http://a.test', 'http://b.test'])
  })

  it('coerces numeric settings', () => {
    expect(loadEnv({ PORT: '8080' }).PORT).toBe(8080)
  })

  it('rejects a non-numeric port', () => {
    expect(() => loadEnv({ PORT: 'not-a-port' })).toThrow(/PORT/)
  })

  it('requires JWT_SECRET in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', ALLOW_ANONYMOUS: 'false' })).toThrow(
      /JWT_SECRET is required in production/
    )
  })

  it('refuses anonymous access in production', () => {
    expect(() =>
      loadEnv({ NODE_ENV: 'production', JWT_SECRET: PROD_SECRET, ALLOW_ANONYMOUS: 'true' })
    ).toThrow(/ALLOW_ANONYMOUS must be false/)
  })

  it('accepts a valid production configuration', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      JWT_SECRET: PROD_SECRET,
      ALLOW_ANONYMOUS: 'false',
    })
    expect(env.ALLOW_ANONYMOUS).toBe(false)
    expect(env.JWT_SECRET).toBe(PROD_SECRET)
  })

  it('falls back to a development secret outside production', () => {
    expect(loadEnv({}).JWT_SECRET).toMatch(/development/)
  })
})
