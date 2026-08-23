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
    expect(() =>
      loadEnv({ NODE_ENV: 'production', ALLOW_ANONYMOUS: 'false', CORS_ORIGIN: 'https://app.test' })
    ).toThrow(/JWT_SECRET is required in production/)
  })

  it('refuses anonymous access in production', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        JWT_SECRET: PROD_SECRET,
        ALLOW_ANONYMOUS: 'true',
        CORS_ORIGIN: 'https://app.test',
      })
    ).toThrow(/ALLOW_ANONYMOUS must be false/)
  })

  it('requires an explicit origin allowlist in production', () => {
    expect(() =>
      loadEnv({ NODE_ENV: 'production', JWT_SECRET: PROD_SECRET, ALLOW_ANONYMOUS: 'false' })
    ).toThrow(/CORS_ORIGIN is required in production/)
  })

  it('accepts a valid production configuration', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      JWT_SECRET: PROD_SECRET,
      ALLOW_ANONYMOUS: 'false',
      CORS_ORIGIN: 'https://syncspace.example, https://www.syncspace.example',
    })
    expect(env.ALLOW_ANONYMOUS).toBe(false)
    expect(env.JWT_SECRET).toBe(PROD_SECRET)
    expect(env.CORS_ORIGIN).toEqual(['https://syncspace.example', 'https://www.syncspace.example'])
  })

  it('falls back to a development secret outside production', () => {
    expect(loadEnv({}).JWT_SECRET).toMatch(/development/)
  })

  it('rejects a wildcard origin', () => {
    expect(() => loadEnv({ CORS_ORIGIN: '*' })).toThrow(/wildcard/)
  })

  it('rejects origins that are not absolute scheme://host[:port]', () => {
    expect(() => loadEnv({ CORS_ORIGIN: 'not an origin' })).toThrow(/absolute origin/)
    expect(() => loadEnv({ CORS_ORIGIN: 'localhost:5173' })).toThrow(/without a path/)
    expect(() => loadEnv({ CORS_ORIGIN: 'https://app.test/rooms' })).toThrow(/without a path/)
    expect(() => loadEnv({ CORS_ORIGIN: 'ftp://app.test' })).toThrow(/without a path/)
  })

  it('rejects an empty allowlist in any environment', () => {
    expect(() => loadEnv({ CORS_ORIGIN: ' , ,' })).toThrow(/at least one origin/)
  })

  it('normalises trailing slashes and default ports away', () => {
    const env = loadEnv({ CORS_ORIGIN: 'http://localhost:5173/, https://app.test:443' })
    expect(env.CORS_ORIGIN).toEqual(['http://localhost:5173', 'https://app.test'])
  })

  it('defaults CLIENT_URL to the first allowed origin', () => {
    const env = loadEnv({
      CORS_ORIGIN: 'https://syncspace.example, https://www.syncspace.example',
    })
    expect(env.CLIENT_URL).toBe('https://syncspace.example')
  })

  it('rejects an SMTP_URL that is not an smtp(s) relay', () => {
    expect(() => loadEnv({ SMTP_URL: 'not a url' })).toThrow(/SMTP_URL must be a URL/)
    expect(() => loadEnv({ SMTP_URL: 'http://mail.test' })).toThrow(/smtp: or smtps:/)
  })

  it('requires MAIL_FROM once a relay is configured', () => {
    expect(() => loadEnv({ SMTP_URL: 'smtps://user:pass@mail.test:465' })).toThrow(
      /MAIL_FROM is required/
    )
  })

  it('accepts a complete email configuration', () => {
    const env = loadEnv({
      SMTP_URL: 'smtps://user:pass@mail.test:465',
      MAIL_FROM: 'SyncSpace <no-reply@syncspace.example>',
      CLIENT_URL: 'https://app.syncspace.example',
    })
    expect(env.CLIENT_URL).toBe('https://app.syncspace.example')
  })

  it('rejects a CLIENT_URL carrying a path', () => {
    expect(() => loadEnv({ CLIENT_URL: 'https://app.test/verify' })).toThrow(/without a path/)
  })
})
