import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { login, register, verifyToken } from '../src/services/auth.service.js'
import {
  RESET_TTL_MINUTES,
  requestPasswordReset,
  resetPassword,
} from '../src/services/password-reset.service.js'
import { issueVerificationToken } from '../src/services/verification.service.js'
import { logger } from '../src/config/logger.js'
import { User } from '../src/models/User.js'

/**
 * Recovering an account nobody can sign in to.
 *
 * Two properties carry most of the weight here and are worth stating plainly,
 * because both are the kind of thing that silently stops being true:
 *
 *   - the database never holds the token the email carries, and
 *   - the endpoint answers a stranger identically whether or not the address
 *     is registered.
 *
 * Lose the first and a leaked backup is a way into every account. Lose the
 * second and an unauthenticated route becomes a list of who has an account.
 */

const ALICE = { email: 'alice@syncspace.test', password: 'correct-horse-battery', name: 'Alice' }
const BOB = { email: 'bob@syncspace.test', password: 'a-different-passphrase', name: 'Bob' }

const NEW_PASSWORD = 'an-entirely-new-passphrase'

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

let infoSpy

beforeEach(async () => {
  await clearDatabase()
  // With no relay configured the message itself is the delivery, so the raw
  // token is read from the log exactly where a real mailer would take it.
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
})

/** Raw reset tokens handed to delivery, oldest first. */
const loggedResetTokens = () =>
  infoSpy.mock.calls
    .map((call) => String(call[1] ?? ''))
    .filter((message) => message.includes('/reset-password?token='))
    .map((message) => message.match(/token=([0-9a-f]{64})/)[1])

const startReset = async (who = ALICE) => {
  await requestPasswordReset(who.email)
  const tokens = loggedResetTokens()
  return tokens[tokens.length - 1]
}

describe('requestPasswordReset', () => {
  it('stores a hash and an expiry, never the token itself', async () => {
    await register(ALICE)
    const raw = await startReset()

    const user = await User.findOne({ email: ALICE.email })
    expect(raw).toMatch(/^[0-9a-f]{64}$/)
    expect(user.resetTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(user.resetTokenHash).not.toBe(raw)
    expect(user.resetTokenExpiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('expires the link within the hour it promises', async () => {
    await register(ALICE)

    // The expiry is stamped somewhere between these two readings, so it lands
    // in [before + TTL, after + TTL] — bracketing it that way is exact,
    // where a one-sided bound is either off by the elapsed time or so loose
    // it would accept a TTL of the wrong order entirely.
    const before = Date.now()
    await startReset()
    const after = Date.now()

    const expiry = (await User.findOne({ email: ALICE.email })).resetTokenExpiresAt.getTime()
    const ttl = RESET_TTL_MINUTES * 60_000

    expect(RESET_TTL_MINUTES).toBe(60)
    expect(expiry).toBeGreaterThanOrEqual(before + ttl)
    expect(expiry).toBeLessThanOrEqual(after + ttl)
  })

  it('never exposes the reset hash through toPublic or toJSON', async () => {
    await register(ALICE)
    await startReset()

    const user = await User.findOne({ email: ALICE.email })
    expect(user.toPublic()).not.toHaveProperty('resetTokenHash')
    expect(JSON.parse(JSON.stringify(user))).not.toHaveProperty('resetTokenHash')
  })

  /**
   * The property that keeps this endpoint from being a membership oracle. It
   * is unauthenticated and public, so anything that separates the two answers
   * — a different body, a different status, an error — hands over the list.
   */
  it('answers an unknown address exactly as it answers a real one', async () => {
    await register(ALICE)

    const known = await requestPasswordReset(ALICE.email)
    const unknown = await requestPasswordReset('nobody@syncspace.test')

    expect(known).toEqual({ sent: true })
    expect(unknown).toEqual(known)
  })

  it('creates nothing for an address that never signed up', async () => {
    await requestPasswordReset('nobody@syncspace.test')

    expect(await User.countDocuments({})).toBe(0)
    expect(loggedResetTokens()).toHaveLength(0)
  })

  it('does not put an address it was handed into the logs', async () => {
    await requestPasswordReset('stranger@syncspace.test')

    const logged = infoSpy.mock.calls.map((call) => JSON.stringify(call)).join(' ')
    expect(logged).not.toContain('stranger@syncspace.test')
  })

  it('finds the account whatever case the address is typed in', async () => {
    await register(ALICE)
    await requestPasswordReset('ALICE@SyncSpace.TEST')

    expect(loggedResetTokens()).toHaveLength(1)
  })

  /** Being locked out has nothing to do with having confirmed the address. */
  it('serves an account that never confirmed its email', async () => {
    await register(ALICE)
    const user = await User.findOne({ email: ALICE.email })
    expect(user.emailVerified).toBe(false)

    expect(await requestPasswordReset(ALICE.email)).toEqual({ sent: true })
    expect(loggedResetTokens()).toHaveLength(1)
  })

  it('asking again invalidates the link it sent first', async () => {
    await register(ALICE)
    const first = await startReset()
    const second = await startReset()

    expect(second).not.toBe(first)
    await expect(resetPassword(first, NEW_PASSWORD)).rejects.toMatchObject({
      code: 'invalid_token',
    })
    await expect(resetPassword(second, NEW_PASSWORD)).resolves.toMatchObject({
      user: { email: ALICE.email },
    })
  })
})

describe('resetPassword', () => {
  it('sets the new password and retires the old one', async () => {
    await register(ALICE)
    const raw = await startReset()

    await resetPassword(raw, NEW_PASSWORD)

    await expect(login({ email: ALICE.email, password: NEW_PASSWORD })).resolves.toMatchObject({
      user: { email: ALICE.email },
    })
    await expect(login({ email: ALICE.email, password: ALICE.password })).rejects.toMatchObject({
      code: 'bad_credentials',
    })
  })

  it('answers a session that actually works', async () => {
    await register(ALICE)
    const raw = await startReset()

    const { user, token } = await resetPassword(raw, NEW_PASSWORD)

    expect(verifyToken(token)).toMatchObject({ sub: user.id })
  })

  /**
   * More important here than for a confirmation link: a reset link that can
   * be spent twice is a permanent way back into the account for anyone who
   * still has the email.
   */
  it('spends the token, so the same link cannot be used twice', async () => {
    await register(ALICE)
    const raw = await startReset()

    await resetPassword(raw, NEW_PASSWORD)

    const user = await User.findOne({ email: ALICE.email })
    expect(user.resetTokenHash).toBeNull()
    expect(user.resetTokenExpiresAt).toBeNull()
    await expect(resetPassword(raw, 'yet-another-passphrase')).rejects.toMatchObject({
      code: 'invalid_token',
    })
  })

  it('refuses a token that has expired', async () => {
    await register(ALICE)
    const raw = await startReset()

    await User.updateOne(
      { email: ALICE.email },
      { $set: { resetTokenExpiresAt: new Date(Date.now() - 1000) } }
    )

    await expect(resetPassword(raw, NEW_PASSWORD)).rejects.toMatchObject({
      code: 'invalid_token',
      status: 400,
    })
    // And the old password still works, so a refused reset changed nothing.
    await expect(login({ email: ALICE.email, password: ALICE.password })).resolves.toBeTruthy()
  })

  it('refuses an unknown token', async () => {
    await register(ALICE)
    await expect(resetPassword('f'.repeat(64), NEW_PASSWORD)).rejects.toMatchObject({
      code: 'invalid_token',
    })
  })

  it('refuses a missing token', async () => {
    await expect(resetPassword(undefined, NEW_PASSWORD)).rejects.toMatchObject({
      code: 'invalid_token',
    })
  })

  it('leaves every other account alone', async () => {
    await register(ALICE)
    await register(BOB)
    const raw = await startReset(ALICE)

    await resetPassword(raw, NEW_PASSWORD)

    await expect(login({ email: BOB.email, password: BOB.password })).resolves.toMatchObject({
      user: { email: BOB.email },
    })
  })

  /**
   * Reading the email is the same proof `/verify-email` accepts, so asking
   * the person to confirm an address they just demonstrated control of would
   * be theatre.
   */
  it('verifies the address, since reading the email proved it', async () => {
    await register(ALICE)
    const raw = await startReset()

    const { user } = await resetPassword(raw, NEW_PASSWORD)

    expect(user.emailVerified).toBe(true)
    const stored = await User.findOne({ email: ALICE.email })
    expect(stored.emailVerifiedAt).toBeInstanceOf(Date)
  })

  it('drops an outstanding confirmation token, which has nothing left to prove', async () => {
    await register(ALICE)
    const user = await User.findOne({ email: ALICE.email })
    await issueVerificationToken(user)

    const raw = await startReset()
    await resetPassword(raw, NEW_PASSWORD)

    const stored = await User.findOne({ email: ALICE.email })
    expect(stored.verificationTokenHash).toBeNull()
    expect(stored.verificationTokenExpiresAt).toBeNull()
  })

  it('keeps the verification date an already-verified account had', async () => {
    await register(ALICE)
    const verifiedAt = new Date(Date.now() - 86_400_000)
    await User.updateOne(
      { email: ALICE.email },
      { $set: { emailVerified: true, emailVerifiedAt: verifiedAt } }
    )

    const raw = await startReset()
    await resetPassword(raw, NEW_PASSWORD)

    const stored = await User.findOne({ email: ALICE.email })
    expect(stored.emailVerifiedAt.getTime()).toBe(verifiedAt.getTime())
  })
})
