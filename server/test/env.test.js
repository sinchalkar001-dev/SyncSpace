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

  /**
   * The parts exist because the URL form does not survive a real password: an
   * app password with an @ or a : in it has to be percent-encoded, and nobody
   * discovers that until mail silently stops.
   */
  describe('a relay given as parts rather than a URL', () => {
    const GMAIL = {
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_USER: 'someone@gmail.com',
      SMTP_PASS: 'abcd efgh ijkl mnop',
    }

    it('strips the spaces Google prints an app password with', () => {
      // Copied from the screen it is shown on, spaces and all — which is what
      // everybody does, and what the relay refuses.
      expect(loadEnv(GMAIL).SMTP_PASS).toBe('abcdefghijklmnop')
    })

    it('takes the From from the account when none is given', () => {
      expect(loadEnv(GMAIL).MAIL_FROM).toBe('someone@gmail.com')
    })

    it('still wants a From when the login is not an address', () => {
      expect(() => loadEnv({ ...GMAIL, SMTP_USER: 'apikey' })).toThrow(/MAIL_FROM is required/)
      expect(loadEnv({ ...GMAIL, SMTP_USER: 'apikey', MAIL_FROM: 'a@b.test' }).MAIL_FROM).toBe('a@b.test')
    })

    it('reads implicit TLS off the port unless told otherwise', () => {
      expect(loadEnv({ ...GMAIL, SMTP_PORT: '465' }).SMTP_SECURE).toBe(true)
      expect(loadEnv({ ...GMAIL, SMTP_PORT: '587' }).SMTP_SECURE).toBe(false)
      expect(loadEnv({ ...GMAIL, SMTP_PORT: '465', SMTP_SECURE: 'false' }).SMTP_SECURE).toBe(false)
    })

    it('defaults to the submission port', () => {
      expect(loadEnv(GMAIL).SMTP_PORT).toBe(587)
    })

    it('refuses half a login, which fails at the relay and looks like a bad password', () => {
      expect(() => loadEnv({ SMTP_HOST: 'mail.test', SMTP_USER: 'me@mail.test' })).toThrow(
        /SMTP_USER and SMTP_PASS go together/
      )
      expect(() => loadEnv({ SMTP_HOST: 'mail.test', SMTP_PASS: 'secret', MAIL_FROM: 'a@b.test' })).toThrow(
        /SMTP_USER and SMTP_PASS go together/
      )
    })

    it('allows a relay that wants no login at all', () => {
      const env = loadEnv({ SMTP_HOST: 'mailhog', SMTP_PORT: '1025', MAIL_FROM: 'dev@syncspace.test' })
      expect(env.SMTP_HOST).toBe('mailhog')
      expect(env.SMTP_USER).toBeUndefined()
    })

    it('refuses both forms at once, since which one would win is nobody’s guess', () => {
      expect(() =>
        loadEnv({ ...GMAIL, SMTP_URL: 'smtps://user:pass@mail.test:465' })
      ).toThrow(/either SMTP_URL or SMTP_HOST/)
    })
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
