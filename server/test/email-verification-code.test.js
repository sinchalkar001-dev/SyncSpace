import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { env } from '../src/config/env.js'
import { User } from '../src/models/User.js'
import { clearOutbox, lastMessage } from '../src/services/email.service.js'

/**
 * The six-digit half of proving an address.
 *
 * The link and the code are not equivalent secrets and this file is mostly
 * about the difference. A 256-bit token only needs an expiry, because nobody
 * is going to guess it. Six digits is a million combinations, which is nothing
 * to a script — so the code expires sooner, is bounded by an attempt count,
 * and burns itself when that count runs out.
 *
 * Nothing here reads a log line to find the code. It comes out of the mail
 * outbox, which is what `EMAIL_PROVIDER=mock` is for: a test that scrapes log
 * output breaks the moment somebody improves the wording, and quietly stops
 * checking anything at all when it does.
 */

let app

const ALICE = { email: 'alice@verify.test', password: 'correct-horse-battery', name: 'Alice' }

const register = (who = ALICE) => request(app).post('/api/v1/auth/register').send(who)
const auth = (token) => ({ Authorization: 'Bearer ' + token })

const verify = (body, token) => {
  const call = request(app).post('/api/v1/auth/verify-email')
  return token ? call.set(auth(token)).send(body) : call.send(body)
}

/** The code as the person receives it: out of the email, not the database. */
function codeFromEmail(to = ALICE.email) {
  const message = lastMessage(to)
  const match = message?.text.match(/\b(\d{6})\b/)
  return match?.[1] ?? null
}

const original = {
  codeMinutes: env.EMAIL_VERIFICATION_CODE_EXPIRY_MINUTES,
  attempts: env.EMAIL_VERIFICATION_MAX_ATTEMPTS,
  cooldown: env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
}

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  clearOutbox()
  app = createApp()
})

afterEach(() => {
  env.EMAIL_VERIFICATION_CODE_EXPIRY_MINUTES = original.codeMinutes
  env.EMAIL_VERIFICATION_MAX_ATTEMPTS = original.attempts
  env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = original.cooldown
})

describe('what registration produces', () => {
  it('creates the account unverified', async () => {
    const res = await register()

    expect(res.status).toBe(201)
    expect(res.body.user.emailVerified).toBe(false)

    const stored = await User.findOne({ email: ALICE.email })
    expect(stored.emailVerified).toBe(false)
    expect(stored.emailVerifiedAt).toBeNull()
  })

  it('emails a link and a code, and stores neither in the clear', async () => {
    await register()

    const message = lastMessage(ALICE.email)
    expect(message.subject).toBe('Verify your SyncSpace email address')
    expect(message.text).toMatch(/\/verify-email\?token=[A-Za-z0-9_-]+/)

    const code = codeFromEmail()
    expect(code).toMatch(/^\d{6}$/)

    // Only hashes are kept, so a database leak cannot be replayed.
    const stored = await User.findOne({ email: ALICE.email })
    expect(stored.verificationCodeHash).toBeTruthy()
    expect(stored.verificationCodeHash).not.toContain(code)
    expect(stored.verificationTokenHash).toBeTruthy()
  })

  it('never puts the code where the API can hand it back', async () => {
    const res = await register()
    const body = JSON.stringify(res.body)

    expect(body).not.toContain(codeFromEmail())
    expect(body).not.toContain('verificationCodeHash')
  })
})

describe('verifying with the code', () => {
  it('verifies the signed-in account', async () => {
    const { body } = await register()

    const res = await verify({ code: codeFromEmail() }, body.token)

    expect(res.status).toBe(200)
    expect(res.body.user.emailVerified).toBe(true)
  })

  /** So the "check your email" screen works before anybody is signed in. */
  it('verifies by address when there is no session', async () => {
    await register()

    const res = await verify({ email: ALICE.email, code: codeFromEmail() })

    expect(res.status).toBe(200)
    expect(res.body.user.emailVerified).toBe(true)
  })

  it('spends the code, so it cannot be replayed', async () => {
    const { body } = await register()
    const code = codeFromEmail()

    expect((await verify({ code }, body.token)).status).toBe(200)

    const again = await verify({ code }, body.token)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('already_verified')
  })

  it('refuses a code that is not the one issued', async () => {
    const { body } = await register()
    const wrong = String((Number(codeFromEmail()) + 1) % 1000000).padStart(6, '0')

    const res = await verify({ code: wrong }, body.token)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_code')
    expect((await User.findOne({ email: ALICE.email })).emailVerified).toBe(false)
  })

  it('refuses something that is not a code at all', async () => {
    const { body } = await register()

    expect((await verify({ code: 'abcdef' }, body.token)).status).toBe(400)
    expect((await verify({}, body.token)).status).toBe(400)
  })

  it('refuses a code that has expired', async () => {
    const { body } = await register()
    const code = codeFromEmail()

    // Reach past the clock rather than waiting out ten real minutes.
    await User.updateOne(
      { email: ALICE.email },
      { $set: { verificationCodeExpiresAt: new Date(Date.now() - 1000) } }
    )

    const res = await verify({ code }, body.token)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('code_expired')
  })
})

describe('guessing the code', () => {
  it('counts wrong answers and says how many are left', async () => {
    env.EMAIL_VERIFICATION_MAX_ATTEMPTS = 3
    const { body } = await register()

    const first = await verify({ code: '000000' }, body.token)
    expect(first.body.error.message).toMatch(/2 attempts left/)

    const second = await verify({ code: '000001' }, body.token)
    expect(second.body.error.message).toMatch(/1 attempt left/)
  })

  /**
   * The important one. Running out must not merely refuse — it has to burn the
   * code, or waiting for the counter to be reset hands the attacker their
   * guesses back and the limit buys nothing.
   */
  it('burns the code when the attempts run out', async () => {
    env.EMAIL_VERIFICATION_MAX_ATTEMPTS = 2
    const { body } = await register()
    const real = codeFromEmail()

    await verify({ code: '000000' }, body.token)
    const spent = await verify({ code: '000001' }, body.token)

    expect(spent.status).toBe(429)
    expect(spent.body.error.code).toBe('too_many_attempts')

    // Even the correct code is now worthless.
    const withReal = await verify({ code: real }, body.token)
    expect(withReal.status).toBe(429)

    const stored = await User.findOne({ email: ALICE.email })
    expect(stored.verificationCodeHash).toBeNull()
    expect(stored.emailVerified).toBe(false)
  })

  it('gives a fresh budget with a fresh code', async () => {
    env.EMAIL_VERIFICATION_MAX_ATTEMPTS = 2
    const { body } = await register()

    await verify({ code: '000000' }, body.token)
    await verify({ code: '000001' }, body.token)

    // A resend is the way out, and it must actually be a way out.
    await request(app).post('/api/v1/auth/resend-verification').set(auth(body.token)).expect(200)

    const res = await verify({ code: codeFromEmail() }, body.token)
    expect(res.status).toBe(200)
  })

  /**
   * Six digits are not unique across accounts. A lookup by code alone would
   * let one person's guess land on somebody else's account.
   */
  it('never lets a code match a different account', async () => {
    const alice = (await register()).body
    await register({ email: 'bob@verify.test', password: 'another-passphrase', name: 'Bob' })

    const bobsCode = codeFromEmail('bob@verify.test')

    const res = await verify({ code: bobsCode }, alice.token)
    // Either it simply does not match, or it is refused — never a verification
    // of Alice using Bob's code.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await User.findOne({ email: ALICE.email })).emailVerified).toBe(false)
  })
})

describe('resending', () => {
  it('replaces the previous code', async () => {
    const { body } = await register()
    const first = codeFromEmail()

    await request(app).post('/api/v1/auth/resend-verification').set(auth(body.token)).expect(200)
    const second = codeFromEmail()

    expect(second).not.toBe(first)

    // The old one is dead, not merely superseded in the email.
    expect((await verify({ code: first }, body.token)).status).toBe(400)
    expect((await verify({ code: second }, body.token)).status).toBe(200)
  })

  it('makes you wait, and says how long', async () => {
    env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = 60
    const { body } = await register()

    const res = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set(auth(body.token))

    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('resend_cooldown')
    expect(res.body.error.message).toMatch(/\d+ seconds/)
  })

  it('refuses once there is nothing left to verify', async () => {
    const { body } = await register()
    await verify({ code: codeFromEmail() }, body.token)

    const res = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set(auth(body.token))

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('already_verified')
  })
})

describe('the status the check-your-email screen renders from', () => {
  it('masks the address and reports what is left', async () => {
    const { body } = await register()

    const res = await request(app)
      .get('/api/v1/auth/verification-status')
      .set(auth(body.token))

    expect(res.status).toBe(200)
    expect(res.body.emailVerified).toBe(false)
    // Enough to recognise, not enough to publish.
    expect(res.body.email).toBe('a***@verify.test')
    expect(res.body.email).not.toBe(ALICE.email)
    expect(res.body.attemptsLeft).toBe(env.EMAIL_VERIFICATION_MAX_ATTEMPTS)
  })

  it('says so once the address is proven', async () => {
    const { body } = await register()
    await verify({ code: codeFromEmail() }, body.token)

    const res = await request(app)
      .get('/api/v1/auth/verification-status')
      .set(auth(body.token))

    expect(res.body.emailVerified).toBe(true)
    expect(res.body.retryAfter).toBe(0)
  })
})

describe('the link in the email', () => {
  it('verifies and sends the browser somewhere useful', async () => {
    await register()
    const token = lastMessage(ALICE.email).text.match(/token=([A-Za-z0-9_-]+)/)[1]

    const res = await request(app).get('/api/v1/auth/verify-email?token=' + token)

    expect(res.status).toBe(302)
    expect(res.headers.location).toContain('status=verified')
    // The token must not travel on to the page, where it would land in history.
    expect(res.headers.location).not.toContain(token)

    expect((await User.findOne({ email: ALICE.email })).emailVerified).toBe(true)
  })

  it('sends a bad link to the same place as an expired one', async () => {
    await register()

    const bad = await request(app).get('/api/v1/auth/verify-email?token=' + 'a'.repeat(64))
    expect(bad.headers.location).toContain('status=invalid')

    const malformed = await request(app).get('/api/v1/auth/verify-email?token=nonsense')
    expect(malformed.headers.location).toContain('status=invalid')
  })
})

describe('signing in before the address is proven', () => {
  const login = () =>
    request(app).post('/api/v1/auth/login').send({ email: ALICE.email, password: ALICE.password })

  it('is allowed by default, so nobody is locked out by the upgrade', async () => {
    await register()
    expect((await login()).status).toBe(200)
  })

  it('is refused when the deployment asks for it', async () => {
    const before = env.REQUIRE_EMAIL_VERIFICATION
    env.REQUIRE_EMAIL_VERIFICATION = true

    try {
      await register()

      const res = await login()
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('email_not_verified')

      // And works the moment the address is proven.
      const stored = await User.findOne({ email: ALICE.email })
      stored.emailVerified = true
      await stored.save()

      expect((await login()).status).toBe(200)
    } finally {
      env.REQUIRE_EMAIL_VERIFICATION = before
    }
  })

  /**
   * A wrong password must not reveal that the address has an account waiting
   * to be verified — that is exactly what `bad_credentials` is worded to avoid.
   */
  it('still says only "bad credentials" for a wrong password', async () => {
    const before = env.REQUIRE_EMAIL_VERIFICATION
    env.REQUIRE_EMAIL_VERIFICATION = true

    try {
      await register()

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: ALICE.email, password: 'not-the-password' })

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('bad_credentials')
    } finally {
      env.REQUIRE_EMAIL_VERIFICATION = before
    }
  })
})
