import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { User } from '../models/User.js'
import { env } from '../config/env.js'
import { AppError, conflict, unauthorized } from '../errors.js'
import { sendVerificationEmail } from './verification.service.js'
import { claimPendingInvites } from './room.service.js'
import { findSession, revokeAllSessions, startSession } from './session.service.js'
import { logger } from '../config/logger.js'

const ROUNDS = 10

export const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS)
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash)

/**
 * Every token belongs to a session row, so minting one is opening a session —
 * there is no way to hand out a token that nothing on this side knows about,
 * which is what makes revoking possible at all.
 *
 * `context` is what the request can say about the device: its user agent and
 * address. It is optional so that a caller with nothing to offer still works;
 * the row simply has less to show in the device list.
 */
export const issueToken = (user, context) => startSession(user, context)

/**
 * Returns the decoded payload, or null when the token is absent or invalid.
 *
 * Signature and expiry only — this says the token was issued by us and has not
 * run out, which is everything that can be known without asking the database.
 * It is deliberately still synchronous and still pure; `authenticate` below is
 * the one that also asks whether the session is *current*.
 */
export function verifyToken(token) {
  if (!token) return null
  try {
    return jwt.verify(token, env.JWT_SECRET)
  } catch {
    return null
  }
}

/** What a refused-but-well-formed token is reported as. */
export const SESSION_REVOKED = 'session_revoked'

/**
 * Whether a token names a session that is still live.
 *
 * A signed JWT cannot be withdrawn — that is the whole point of it — so the
 * only way to end one early is to keep a record on this side and check it.
 * That record is a row per signed-in device, named by the token's `jti`. No
 * row means the session is over: revoked, expired, or never recorded.
 *
 * The cost is one read on a unique index, projected to three fields, per
 * authenticated request — and none at all for a request that carries no token,
 * which is every guest. Deliberately not cached: a cache in front of a
 * revocation check is how a revocation quietly stops working, and every
 * handler this guards already does more database work than this adds. If it
 * ever shows up in a profile, that is the moment to put something in front of
 * it — with an invalidation path, not just a TTL.
 *
 * Answers `{ user, revoked }`. `user` is null when there is no usable session,
 * and carries the session's id when there is, so a connection can record which
 * device it belongs to and be hung up by name later. `revoked` separates "this
 * was a real session and it has ended" from "this is not a token", which is
 * the difference between "sign in again" and "something went wrong".
 */
export async function authenticate(token) {
  const payload = verifyToken(token)
  if (!payload) return { user: null, revoked: false }

  /**
   * A token with no `jti` predates sessions being recorded, so there is
   * nothing to check it against and no way to revoke it. It is refused rather
   * than grandfathered: accepting it would leave a token that "sign out
   * everywhere" cannot reach, which is precisely the hole this exists to
   * close. The cost is that deploying signs everyone out once.
   */
  const session = await findSession(payload.jti)
  if (!session) return { user: null, revoked: true }

  return {
    user: { id: payload.sub, name: payload.name, sessionId: String(session._id), jti: payload.jti },
    revoked: false,
  }
}

export async function register({ email, password, name }, context) {
  const existing = await User.findOne({ email: email.toLowerCase() })
  if (existing) throw conflict('That email is already registered', 'email_taken')

  const user = await User.create({
    email: email.toLowerCase(),
    name,
    passwordHash: await hashPassword(password),
  })

  // Every account is born with a pending verification email; failing to
  // prepare it fails the sign-up, since an unverifiable account is worse
  // than no account.
  await sendVerificationEmail(user)

  /**
   * Anyone invited to a room by this address has been waiting for exactly
   * this moment. Failing here would be the wrong trade — the account is
   * already real, and an invitation the owner can re-send is a smaller loss
   * than a sign-up that appears to have failed.
   */
  let rooms = []
  try {
    rooms = await claimPendingInvites(user)
  } catch (error) {
    logger.error({ err: error, user: user.id }, 'could not claim pending room invites')
  }

  return { user: user.toPublic(), token: await issueToken(user, context), rooms }
}

export async function login({ email, password }, context) {
  const user = await User.findOne({ email: email.toLowerCase() })
  // Compare regardless of whether the user exists so timing does not leak it.
  const hash = user ? user.passwordHash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin'
  const ok = await verifyPassword(password, hash)

  if (!user || !ok) throw unauthorized('Incorrect email or password', 'bad_credentials')

  /**
   * An unverified account may or may not sign in, and that is a deployment
   * decision rather than a product one.
   *
   * Off by default, because turning it on locks out every account that has
   * not verified yet — including every account created before verification
   * was enforced at all. A deployment turns it on once the people who need to
   * verify have had the chance, which is the migration this feature needs and
   * cannot perform for anybody.
   *
   * The refusal comes *after* the password check on purpose. Answering
   * `email_not_verified` to a wrong password would confirm the address exists
   * and has an account, which is exactly what `bad_credentials` is worded to
   * avoid.
   */
  if (env.REQUIRE_EMAIL_VERIFICATION && !user.emailVerified) {
    throw new AppError(
      403,
      'Verify your email address before signing in',
      'email_not_verified'
    )
  }

  // A new sign-in is a new device in the list, not a replacement for whatever
  // is already there — that is the whole point of listing them.
  return { user: user.toPublic(), token: await issueToken(user, context) }
}

/**
 * Rotates the password and ends every session that was open under the old one.
 *
 * Answers a token as well as the account, which it must: minting a new epoch
 * is what stops the old tokens working, and the caller was holding one of
 * them. Without a replacement, changing your password would sign you out of
 * the tab you changed it in.
 *
 * Every *other* device is signed out, which is the point — a password change
 * is the ordinary way to end a session on a laptop you no longer have.
 */
export async function changePassword(userId, currentPassword, newPassword, context) {
  const user = await User.findById(userId)
  if (!user) throw unauthorized('User not found', 'user_not_found')

  const ok = await verifyPassword(currentPassword, user.passwordHash)
  if (!ok) throw unauthorized('Current password is incorrect', 'bad_password')

  user.passwordHash = await hashPassword(newPassword)
  await user.save()

  /**
   * Every session goes, including the caller's — there is no point keeping one
   * that was opened with a credential that no longer exists — and a fresh one
   * is opened immediately after. Ordered this way round so the new session
   * cannot be caught by its own revocation.
   */
  await revokeAllSessions(user.id, 'password_changed')

  return { user: user.toPublic(), token: await issueToken(user, context) }
}
