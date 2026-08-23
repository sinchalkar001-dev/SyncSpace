import { createHash, randomBytes } from 'node:crypto'
import { User } from '../models/User.js'
import { badRequest, conflict, notFound } from '../errors.js'
import { env } from '../config/env.js'
import { sendVerificationEmail as sendMessage } from './email.service.js'

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

/** The one link that proves control of the address. */
function confirmLink(raw) {
  return env.CLIENT_URL + '/verify-email?token=' + raw
}

/**
 * Hands the confirm link to the email service. `sendMessage` never throws —
 * a relay outage is answered by the user pressing "resend", not by failing
 * registration — and with no SMTP configured it logs the message, which
 * keeps development and tests working without credentials.
 */
async function deliverVerificationLink(email, raw) {
  await sendMessage(email, { url: confirmLink(raw) })
}

/** Issues a fresh token for `user` and hands the confirm link to the mailer. */
export async function sendVerificationEmail(user) {
  const raw = await issueVerificationToken(user)
  deliverVerificationLink(user.email, raw)
}

/**
 * Re-issues the verification email for the signed-in account. Refuses
 * `already_verified` rather than silently succeeding, so a client stuck on
 * the "check your inbox" screen learns it can move on.
 */
export async function resendVerification(userId) {
  const user = await User.findById(userId)
  if (!user) throw notFound('User not found', 'user_not_found')
  if (user.emailVerified) throw conflict('This account is already verified', 'already_verified')

  await sendVerificationEmail(user)
  // `sent` means processed, not proven delivered — reporting provider
  // outages here would let outsiders probe the mail setup.
  return { sent: true }
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
