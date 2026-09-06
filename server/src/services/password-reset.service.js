import { User } from '../models/User.js'
import { badRequest } from '../errors.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { hashToken, randomToken } from '../utils/token.js'
import { hashPassword, issueToken } from './auth.service.js'
import { revokeAllSessions } from './session.service.js'
import { sendPasswordResetEmail as sendMessage } from './email.service.js'

/**
 * Recovering an account nobody can sign in to.
 *
 * `change-password` has always required the current password, which is exactly
 * the thing a locked-out person does not have. Without this flow the only
 * remedy was a second account, and every room, file and replay attached to the
 * first one was gone for good.
 *
 * Deliberately shaped like the verification flow next door — a hashed,
 * single-use token with an expiry — because the two are the same problem
 * (prove control of a mailbox) with different stakes.
 */

/**
 * How long a reset link lives.
 *
 * An hour, against the confirmation link's 24. Both prove control of an
 * address, but this one hands over the account, so the window in which a
 * forwarded message or a mailbox breached later is worth anything to somebody
 * is worth keeping short. It is also long enough for the realistic case:
 * asking on a phone and finishing on a laptop.
 */
const TOKEN_TTL_MS = 60 * 60 * 1000

export const RESET_TTL_MINUTES = TOKEN_TTL_MS / 60000

/** The one link that lets someone choose a new password. */
function resetLink(raw) {
  return env.CLIENT_URL + '/reset-password?token=' + raw
}

/**
 * Hands the reset link to the email service.
 *
 * Nothing awaits this, for the same reason the verification flow does not: the
 * request has already been answered by the time it settles, so a rejection
 * would have nobody to catch it, and an unhandled rejection ends the process.
 * Only the error class is logged, since relay failures can echo credentials.
 */
function deliverResetLink(email, raw) {
  return sendMessage(email, { url: resetLink(raw), minutes: RESET_TTL_MINUTES }).catch((error) => {
    logger.warn({ code: error?.code ?? error?.name }, 'could not send the password reset email')
  })
}

/**
 * Starts a reset for `email`, if there is anything to start.
 *
 * Answers `{ sent: true }` either way, and that is the entire security model
 * of this endpoint. Saying "no account with that address" would turn a public,
 * unauthenticated route into a membership oracle: anyone could test a list of
 * addresses against it and learn who has an account here. The same reasoning
 * already governs `login`, which compares against a dummy hash so that even
 * the timing does not separate a wrong password from an unknown address.
 *
 * A residual timing difference remains — a known address costs one save that
 * an unknown one does not — but delivery is not awaited, so the response does
 * not wait on the relay, which is where a difference large enough to measure
 * over the internet would come from.
 *
 * Requesting again invalidates the previous link. That is the useful default:
 * a person who presses the button twice expects the newest email to work, and
 * an older link left live is one more thing an old mailbox could still spend.
 *
 * Unverified accounts are served too. Being locked out has nothing to do with
 * having confirmed an address, and refusing here would strand exactly the
 * people who never finished signing up.
 */
export async function requestPasswordReset(email) {
  const address = String(email || '').toLowerCase()
  const user = await User.findOne({ email: address })

  if (user) {
    const raw = randomToken()
    user.resetTokenHash = hashToken(raw)
    user.resetTokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS)
    await user.save()

    deliverResetLink(user.email, raw)
  } else {
    // Not an error, and not silence either: an address that nobody registered
    // is worth knowing about on this side, where it may be the first sign of
    // somebody working through a list.
    logger.info({ email: '***' }, 'password reset requested for an unknown address')
  }

  // `sent` means processed, not proven delivered — reporting relay outages
  // here would let outsiders probe the mail setup.
  return { sent: true }
}

/**
 * Sets a new password for whoever holds `raw`.
 *
 * The token is consumed, so a link cannot be spent twice — which matters more
 * here than for confirmation, because a replayable reset link in an inbox is a
 * permanent way back into the account.
 *
 * Verifying the address as a side effect is not a shortcut. Reading this email
 * is the same proof `/verify-email` accepts, so someone who resets a password
 * from a link has demonstrated exactly what the confirmation flow asks for,
 * and leaving them nagged to confirm an address they just proved would be
 * theatre. Any outstanding confirmation token is dropped at the same time: it
 * has nothing left to prove.
 *
 * Every session open under the old password is ended. That matters more here
 * than anywhere else in the app: the reason someone resets a password they
 * cannot remember is often that somebody else can, and a reset that left the
 * intruder's token working would be the appearance of security rather than
 * security. Deleting the session rows stops the old tokens being accepted, and
 * the live connections they authenticated are hung up with them — nothing
 * would otherwise ask an open websocket again.
 */
export async function resetPassword(raw, newPassword, context) {
  if (!raw) throw badRequest('Reset token required', 'invalid_token')

  const user = await User.findOne({
    resetTokenHash: hashToken(raw),
    resetTokenExpiresAt: { $gt: new Date() },
  })

  if (!user) throw badRequest('This reset link is invalid or has expired', 'invalid_token')

  user.passwordHash = await hashPassword(newPassword)
  user.resetTokenHash = null
  user.resetTokenExpiresAt = null

  if (!user.emailVerified) {
    user.emailVerified = true
    user.emailVerifiedAt = new Date()
  }
  user.verificationTokenHash = null
  user.verificationTokenExpiresAt = null

  await user.save()

  // Every session opened under the old password ends here, before the new one
  // is opened below so it cannot be caught by its own revocation.
  await revokeAllSessions(user.id, 'password_reset')

  // Signed straight in: they hold a token that proved control of the address
  // and have just chosen the password, so a sign-in form here would only ask
  // them to retype what they typed a second ago.
  return { user: user.toPublic(), token: await issueToken(user, context) }
}
