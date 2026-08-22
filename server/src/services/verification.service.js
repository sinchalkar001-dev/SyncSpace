import { createHash, randomBytes } from 'node:crypto'
import { User } from '../models/User.js'
import { badRequest } from '../errors.js'

// Verification links should be used promptly; 24h is the usual balance.
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/** Only the hash is persisted, so the raw token exists in exactly one place: the email. */
function hashToken(raw) {
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Generates a verification token for `user`, storing only its hash and an
 * expiry. Re-issuing invalidates any previous token. Returns the raw token
 * so a future mailer can build the confirm link.
 */
export async function issueVerificationToken(user) {
  const raw = randomBytes(32).toString('hex')

  user.verificationTokenHash = hashToken(raw)
  user.verificationTokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS)
  await user.save()

  return raw
}

/**
 * Marks the account verified when `raw` matches a live token. Consuming the
 * token clears it, so it cannot be replayed. Throws `invalid_token` when the
 * token is unknown, expired, already used, or the address was verified by
 * another means.
 */
export async function verifyEmail(raw) {
  if (!raw) throw badRequest('Verification token required', 'invalid_token')

  const user = await User.findOne({
    verificationTokenHash: hashToken(raw),
    verificationTokenExpiresAt: { $gt: new Date() },
    emailVerified: false,
  })

  if (!user) throw badRequest('This verification link is invalid or has expired', 'invalid_token')

  user.emailVerified = true
  user.emailVerifiedAt = new Date()
  user.verificationTokenHash = null
  user.verificationTokenExpiresAt = null
  await user.save()

  return user
}
