import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { User } from '../models/User.js'
import { AppError, badRequest, conflict, notFound } from '../errors.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { hashToken, randomToken } from '../utils/token.js'
import { maskEmail, sendVerificationEmail as sendMessage } from './email.service.js'
import { claimInvitesFor } from './invitation.service.js'

/**
 * Proving that somebody can read the address they signed up with.
 *
 * Two ways to prove it, because they suit different situations. The link is
 * one tap on whatever device holds the mailbox. The code is what you use when
 * the email is on your phone and SyncSpace is open on a laptop — and the
 * alternative there is retyping a 64-character token, which nobody does.
 *
 * They are not equivalent secrets and are not treated as one. The token is 256
 * bits: unguessable, so it only needs an expiry. The code is six digits: a
 * million combinations, which is nothing to a script, so it expires sooner,
 * is compared in constant time, and is bounded by an attempt count. Giving the
 * code the token's half-hour and no attempt limit would make the whole scheme
 * as strong as its weakest half.
 *
 * Nothing here ever logs a token or a code.
 */

const minutes = (n) => n * 60 * 1000

const tokenTtl = () => minutes(env.EMAIL_VERIFICATION_TOKEN_EXPIRY_MINUTES)
const codeTtl = () => minutes(env.EMAIL_VERIFICATION_CODE_EXPIRY_MINUTES)

/**
 * Six digits from a cryptographic source, zero-padded.
 *
 * `randomInt` rather than `Math.random`, which is seeded predictably enough
 * that a code generated from it is guessable given a couple of samples.
 * Padding matters: without it "000482" would be sent as "482" and the person
 * would type six characters that could never match.
 */
export function generateCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** Same one-way treatment as the token; the digits are never stored. */
const hashCode = (code) => createHash('sha256').update(String(code)).digest('hex')

/**
 * Compares two hashes without leaking where they first differ.
 *
 * A plain `===` on a hash returns as soon as it finds a mismatch, and the time
 * that takes is measurable across enough requests. It is a small leak against
 * a hash and a real one if this is ever pointed at something shorter, so the
 * comparison is written the safe way once rather than reasoned about again.
 */
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * Issues a fresh token and code, replacing whatever came before.
 *
 * Re-issuing invalidates the previous pair — that is the point of the resend
 * button — and resets the attempt counter, because the budget belongs to the
 * code rather than to the account. Somebody who mistyped twice yesterday
 * should not find themselves locked out of a code they have just received.
 *
 * Returns the raw values, which exist in exactly two places: this return, and
 * the email.
 */
export async function issueVerification(user) {
  const token = randomToken()
  const code = generateCode()
  const now = new Date()

  user.verificationTokenHash = hashToken(token)
  user.verificationTokenExpiresAt = new Date(now.getTime() + tokenTtl())
  user.verificationCodeHash = hashCode(code)
  user.verificationCodeExpiresAt = new Date(now.getTime() + codeTtl())
  user.verificationAttempts = 0
  user.lastVerificationSentAt = now
  await user.save()

  return { token, code }
}

/** Kept for callers that only ever wanted the link. */
export async function issueVerificationToken(user) {
  return (await issueVerification(user)).token
}

/** The one link that proves control of the address. */
const confirmLink = (token) => env.CLIENT_URL + '/verify-email?token=' + token

/**
 * Hands the message to the mail service.
 *
 * `sendMessage` never throws — a relay outage is answered by the person
 * pressing resend, not by failing registration — and with no relay configured
 * it logs the message and files it in the outbox, which keeps development and
 * the tests working without credentials.
 *
 * The catch is for the day that stops being true. Nothing awaits this call:
 * registration has already answered by the time it settles, so a rejection
 * would have nobody to catch it, and an unhandled rejection ends the process,
 * losing every open room to a mail problem. Only the error class is logged,
 * since relay failures can echo credentials.
 */
function deliver(user, { token, code }) {
  return sendMessage(user.email, {
    url: confirmLink(token),
    code,
    tokenMinutes: env.EMAIL_VERIFICATION_TOKEN_EXPIRY_MINUTES,
    codeMinutes: env.EMAIL_VERIFICATION_CODE_EXPIRY_MINUTES,
  })
    .then((result) => {
      logger.info(
        { user: String(user._id), to: maskEmail(user.email), delivered: result?.delivered ?? false },
        'verification email requested'
      )
      return result
    })
    .catch((error) => {
      logger.warn(
        { user: String(user._id), code: error?.code ?? error?.name },
        'could not send the verification email'
      )
      return { delivered: false }
    })
}

/**
 * Issues a fresh pair for `user` and hands it to the mailer.
 *
 * The send is deliberately not returned, and that is not an oversight. The
 * caller is registration, which awaits this — returning the promise makes
 * signing up as slow as the mail relay, and against a relay that never answers
 * it makes signing up hang forever. Delivery is not part of creating an
 * account; the account exists unverified either way, and the answer to a
 * failed send is the person pressing resend.
 */
export async function sendVerificationEmail(user) {
  const issued = await issueVerification(user)
  deliver(user, issued)
}

/** Seconds still to wait before another verification email may be sent. */
export function cooldownRemaining(user) {
  const wait = env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS
  if (!wait || !user?.lastVerificationSentAt) return 0

  const elapsed = (Date.now() - new Date(user.lastVerificationSentAt).getTime()) / 1000
  return Math.max(0, Math.ceil(wait - elapsed))
}

/**
 * Re-issues the verification email for an account.
 *
 * Refuses `already_verified` rather than silently succeeding, so a client
 * stuck on the "check your inbox" screen learns it can move on. The cooldown
 * is what stops this endpoint being a way to mail-bomb an address, and it
 * reports the wait so the interface can count it down rather than guessing.
 */
export async function resendVerification(userId) {
  const user = await User.findById(userId)
  if (!user) throw notFound('User not found', 'user_not_found')
  if (user.emailVerified) throw conflict('This account is already verified', 'already_verified')

  const wait = cooldownRemaining(user)
  if (wait > 0) {
    const error = new AppError(
      429,
      'You can request another verification email in ' + wait + ' seconds',
      'resend_cooldown'
    )
    error.retryAfter = wait
    throw error
  }

  await sendVerificationEmail(user)

  // `sent` means processed, not proven delivered — reporting provider outages
  // here would let outsiders probe the mail setup.
  return { sent: true, retryAfter: env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS }
}

/**
 * Everything about a finished verification, in one place.
 *
 * Claiming invitations happens here as well as at registration, and this is
 * the half that matters when verification is enforced: an invitation must not
 * walk somebody past proving they can read the address, so it waits here until
 * they have. A failure to claim is logged rather than thrown — the address is
 * verified either way, and an invitation the owner can re-send is a smaller
 * loss than a verification that appears to have failed.
 */
async function markVerified(user) {
  user.emailVerified = true
  user.emailVerifiedAt = new Date()
  user.verificationTokenHash = null
  user.verificationTokenExpiresAt = null
  user.verificationCodeHash = null
  user.verificationCodeExpiresAt = null
  user.verificationAttempts = 0
  await user.save()

  try {
    await claimInvitesFor(user)
  } catch (error) {
    logger.warn({ err: error, user: String(user._id) }, 'could not claim invites after verification')
  }

  return user
}

/**
 * Marks the account verified when `raw` matches a live token.
 *
 * The token is found by its hash, so an unknown or expired one simply matches
 * nothing — there is no branch here that could tell an attacker which of the
 * two it was.
 */
export async function verifyEmail(raw) {
  if (!raw) throw badRequest('Verification token required', 'invalid_token')

  const user = await User.findOne({
    verificationTokenHash: hashToken(raw),
    verificationTokenExpiresAt: { $gt: new Date() },
    emailVerified: false,
  })

  if (!user) throw badRequest('This verification link is invalid or has expired', 'invalid_token')

  await markVerified(user)
  logger.info({ user: String(user._id), method: 'link' }, 'email verification succeeded')
  return user
}

/**
 * Marks the account verified when `code` matches the one issued to it.
 *
 * Looked up by account rather than by code, which matters: six digits are not
 * unique across users, and a search by value alone would let one person's
 * guess land on somebody else's account.
 *
 * A wrong code spends one of the attempts. Running out invalidates the code
 * outright rather than merely refusing — otherwise waiting for the counter to
 * be reset by a resend would hand the attacker their guesses back.
 */
export async function verifyEmailCode({ userId, email, code }) {
  if (!code || !/^\d{4,8}$/.test(String(code).trim())) {
    throw badRequest('That verification code is not valid', 'invalid_code')
  }

  const user = userId
    ? await User.findById(userId)
    : email
      ? await User.findOne({ email: String(email).trim().toLowerCase() })
      : null

  // Deliberately the same refusal as a wrong code: distinguishing "no such
  // account" here would turn this endpoint into a way to test addresses.
  if (!user) throw badRequest('That verification code is not valid or has expired', 'invalid_code')

  if (user.emailVerified) throw conflict('This account is already verified', 'already_verified')

  /**
   * Asked before expiry, and the order is the whole point.
   *
   * Running out of attempts burns the code, which leaves it looking exactly
   * like an expired one. Checking expiry first would tell somebody who had
   * just been locked out that their code "expired" — true only in the sense
   * that it no longer works, and it sends them to wait rather than to the
   * resend button that is actually their way out.
   */
  if (user.verificationAttempts >= env.EMAIL_VERIFICATION_MAX_ATTEMPTS) {
    throw new AppError(
      429,
      'Too many incorrect codes. Ask for a new verification email.',
      'too_many_attempts'
    )
  }

  const expired =
    !user.verificationCodeHash ||
    !user.verificationCodeExpiresAt ||
    user.verificationCodeExpiresAt.getTime() <= Date.now()

  if (expired) {
    logger.info({ user: String(user._id) }, 'email verification failed: code expired')
    throw badRequest('That verification code has expired — ask for a new one', 'code_expired')
  }

  if (!sameHash(hashCode(String(code).trim()), user.verificationCodeHash)) {
    user.verificationAttempts += 1

    // The last allowed guess burns the code rather than leaving it live for
    // whoever resets the counter next.
    const spent = user.verificationAttempts >= env.EMAIL_VERIFICATION_MAX_ATTEMPTS
    if (spent) {
      user.verificationCodeHash = null
      user.verificationCodeExpiresAt = null
    }
    await user.save()

    logger.info(
      { user: String(user._id), attempts: user.verificationAttempts, spent },
      'email verification failed: wrong code'
    )

    if (spent) {
      throw new AppError(
        429,
        'Too many incorrect codes. Ask for a new verification email.',
        'too_many_attempts'
      )
    }

    const left = env.EMAIL_VERIFICATION_MAX_ATTEMPTS - user.verificationAttempts
    throw badRequest(
      'That code is not right — ' + left + (left === 1 ? ' attempt' : ' attempts') + ' left',
      'invalid_code'
    )
  }

  await markVerified(user)
  logger.info({ user: String(user._id), method: 'code' }, 'email verification succeeded')
  return user
}

/** What the "check your email" screen needs to render itself. */
export async function verificationStatus(userId) {
  const user = await User.findById(userId)
  if (!user) throw notFound('User not found', 'user_not_found')

  return {
    email: maskEmail(user.email),
    emailVerified: user.emailVerified,
    emailVerifiedAt: user.emailVerifiedAt,
    // Null once verified: there is nothing left to wait for.
    retryAfter: user.emailVerified ? 0 : cooldownRemaining(user),
    codeExpiresAt: user.emailVerified ? null : user.verificationCodeExpiresAt,
    attemptsLeft: user.emailVerified
      ? null
      : Math.max(0, env.EMAIL_VERIFICATION_MAX_ATTEMPTS - user.verificationAttempts),
  }
}
