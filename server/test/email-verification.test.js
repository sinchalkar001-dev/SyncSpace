import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { register } from '../src/services/auth.service.js'
import { issueVerificationToken, verifyEmail } from '../src/services/verification.service.js'
import { User } from '../src/models/User.js'

const ALICE = { email: 'alice@syncspace.test', password: 'correct-horse-battery', name: 'Alice' }

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)
beforeEach(clearDatabase)

const newUser = async () => {
  const { user } = await register(ALICE)
  return User.findById(user.id)
}

describe('email verification model', () => {
  it('starts every account unverified with no token outstanding', async () => {
    const user = await newUser()
    expect(user.emailVerified).toBe(false)
    expect(user.verificationTokenHash).toBeNull()
    expect(user.emailVerifiedAt).toBeNull()
  })

  it('never exposes the token hash through toPublic or toJSON', async () => {
    const user = await newUser()
    const raw = await issueVerificationToken(user)

    expect(raw).toEqual(expect.any(String))
    expect(user.toPublic()).not.toHaveProperty('verificationTokenHash')
    expect(JSON.parse(JSON.stringify(user))).not.toHaveProperty('verificationTokenHash')
    expect(user.toJSON().passwordHash).toBeUndefined()
  })

  it('issues a hashed token with a future expiry, not the raw value', async () => {
    const user = await newUser()
    const raw = await issueVerificationToken(user)

    const stored = await User.findById(user._id)
    expect(stored.verificationTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.verificationTokenHash).not.toBe(raw)
    expect(stored.verificationTokenExpiresAt.getTime()).toBeGreaterThan(Date.now())
  })
})

describe('verifyEmail token validation', () => {
  it('verifies a valid token and consumes it', async () => {
    const user = await newUser()
    const raw = await issueVerificationToken(user)
    const before = Date.now()

    const verified = await verifyEmail(raw)

    expect(String(verified._id)).toBe(String(user._id))
    expect(verified.emailVerified).toBe(true)
    expect(verified.emailVerifiedAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(verified.verificationTokenHash).toBeNull()
    expect(verified.verificationTokenExpiresAt).toBeNull()

    // The consumed token cannot be replayed
    await expect(verifyEmail(raw)).rejects.toMatchObject({ code: 'invalid_token' })
  })

  it('rejects an unknown token', async () => {
    await expect(verifyEmail('f'.repeat(64))).rejects.toMatchObject({ code: 'invalid_token' })
  })

  it('rejects a missing token', async () => {
    await expect(verifyEmail(undefined)).rejects.toMatchObject({ code: 'invalid_token' })
  })

  it('rejects a token issued for one account when presented for another', async () => {
    const alice = await newUser()
    await issueVerificationToken(alice)

    const bob = await User.create({
      email: 'bob@syncspace.test',
      passwordHash: '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin',
      name: 'Bob',
    })
    const bobRaw = await issueVerificationToken(bob)

    await verifyEmail(bobRaw)
    const [aliceReloaded, bobReloaded] = await Promise.all([
      User.findById(alice._id),
      User.findById(bob._id),
    ])
    await expect(verifyEmail(bobRaw)).rejects.toMatchObject({ code: 'invalid_token' })
    expect(bobReloaded.emailVerified).toBe(true)
    expect(aliceReloaded.emailVerified).toBe(false)
  })

  it('rejects an expired token', async () => {
    const user = await newUser()
    const raw = await issueVerificationToken(user)
    await User.findByIdAndUpdate(user._id, {
      verificationTokenExpiresAt: new Date(Date.now() - 1000),
    })

    await expect(verifyEmail(raw)).rejects.toMatchObject({ code: 'invalid_token' })

    const reloaded = await User.findById(user._id)
    expect(reloaded.emailVerified).toBe(false)
  })

  it('invalidates the previous token when a new one is issued', async () => {
    const user = await newUser()
    const first = await issueVerificationToken(user)
    const second = await issueVerificationToken(user)

    await verifyEmail(second)
    await expect(verifyEmail(first)).rejects.toMatchObject({ code: 'invalid_token' })
  })

  it('refuses to verify an already-verified account', async () => {
    const user = await newUser()
    const raw = await issueVerificationToken(user)
    await verifyEmail(raw)

    await expect(verifyEmail(raw)).rejects.toMatchObject({ code: 'invalid_token' })
    const reloaded = await User.findById(user._id)
    expect(reloaded.emailVerified).toBe(true)
  })
})
