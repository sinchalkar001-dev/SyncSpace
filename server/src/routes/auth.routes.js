import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../middleware/validate.js'
import { optionalAuth, requireAuth } from '../middleware/auth.js'
import { createRateLimiters } from '../middleware/rateLimit.js'
import { changePassword, login, register } from '../services/auth.service.js'
import {
  resendVerification,
  verificationStatus,
  verifyEmail,
  verifyEmailCode,
} from '../services/verification.service.js'
import { requestPasswordReset, resetPassword } from '../services/password-reset.service.js'
import { listSessions, revokeOtherSessions, revokeSession } from '../services/session.service.js'
import { TOKEN_PATTERN } from '../utils/token.js'
import { User } from '../models/User.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { notFound } from '../errors.js'

const credentials = z.object({
  email: z.string().email().max(160),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(32).optional(),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
})

// Tokens are 32 random bytes hex-encoded by issueVerificationToken; the shape
// check rejects garbage before it can reach a database lookup.
/**
 * Either proof of the address will do.
 *
 * One endpoint rather than two, because they answer the same question and a
 * client that has just been handed a code should not have to know it is now
 * talking to a different route. The refinement is what stops an empty body
 * being read as "verified".
 */
const verificationSchema = z
  .object({
    token: z.string().regex(TOKEN_PATTERN, 'malformed verification token').optional(),
    code: z.string().trim().regex(/^\d{4,8}$/, 'a verification code is 6 digits').optional(),
    // Lets somebody verify from the "check your email" screen without being
    // signed in — the code is only useful to whoever received it.
    email: z.string().email().max(160).optional(),
  })
  .refine((value) => Boolean(value.token) || Boolean(value.code), {
    message: 'provide either a verification token or a code',
  })

const forgotPasswordSchema = z.object({
  email: z.string().email().max(160),
})

/**
 * The same shape check, and the same password rule registration uses — a
 * reset must not be a way around a minimum the sign-up form enforces.
 */
const resetPasswordSchema = z.object({
  token: z.string().regex(TOKEN_PATTERN, 'malformed reset token'),
  password: z.string().min(8).max(200),
})

/**
 * What the request can say about the device opening a session.
 *
 * Both values are shown back to the account they belong to and to nobody else.
 * They are what makes a device list readable — "Chrome on Windows, from an
 * address I do not recognise" is the whole reason somebody opens it — and they
 * are stored only for as long as the session, because revoking deletes the row.
 *
 * `req.ip` is Express's, so it follows `trust proxy`: behind a load balancer
 * without that set, every session records the balancer's address rather than
 * the visitor's. Wrong, but wrong in the harmless direction — it never blames
 * the wrong person, it merely stops being useful.
 */
const deviceFrom = (req) => ({ userAgent: req.get('user-agent') ?? null, ip: req.ip ?? null })

export function createAuthRouter() {
  const authRouter = Router()
  const {
    registerLimiter,
    loginLimiter,
    passwordChangeLimiter,
    verifyLimiter,
    resendVerificationLimiter,
    forgotPasswordLimiter,
    resetPasswordLimiter,
    sessionRevokeLimiter,
  } = createRateLimiters()

  authRouter.post('/register', registerLimiter, validate(credentials), async (req, res, next) => {
    try {
      const { email, password, name } = req.body
      const account = { email, password, name: name || email.split('@')[0] }
      res.status(201).json(await register(account, deviceFrom(req)))
    } catch (err) {
      next(err)
    }
  })

  authRouter.post('/login', loginLimiter, validate(credentials.omit({ name: true })), async (req, res, next) => {
    try {
      res.json(await login(req.body, deviceFrom(req)))
    } catch (err) {
      next(err)
    }
  })

  /**
   * Public: whichever proof arrived is the authorisation.
   *
   * The token is unguessable, so holding it is proof on its own. The code is
   * six digits, so it is only accepted against a named account — by session
   * when there is one, otherwise by the address it was sent to — and the
   * service bounds how many times it may be tried.
   */
  authRouter.post(
    '/verify-email',
    optionalAuth,
    verifyLimiter,
    validate(verificationSchema),
    async (req, res, next) => {
      try {
        const user = req.body.token
          ? await verifyEmail(req.body.token)
          : await verifyEmailCode({
              userId: req.user?.id,
              email: req.body.email,
              code: req.body.code,
            })

        res.json({ user: user.toPublic() })
      } catch (err) {
        next(err)
      }
    }
  )

  /**
   * The link in the email lands here.
   *
   * A GET so that clicking it works from any mail client, and a redirect
   * rather than JSON because a person following a link expects a page. The
   * outcome travels in the query string so the client can render the right
   * state without a second round trip — and the token never appears in the
   * destination, which would put it in browser history.
   */
  authRouter.get('/verify-email', verifyLimiter, async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : ''
    const to = (status) => env.CLIENT_URL + '/verify-email?status=' + status

    if (!TOKEN_PATTERN.test(token)) {
      res.redirect(to('invalid'))
      return
    }

    try {
      await verifyEmail(token)
      res.redirect(to('verified'))
    } catch {
      // Every failure reads the same to the person: the link did not work.
      // Which of expired, spent or unknown it was is in the log, not the URL.
      res.redirect(to('invalid'))
    }
  })

  /** What the "check your email" screen needs to render itself. */
  authRouter.get('/verification-status', requireAuth, async (req, res, next) => {
    try {
      res.json(await verificationStatus(req.user.id))
    } catch (err) {
      next(err)
    }
  })

  /**
   * Public, and deliberately incurious: it answers the same `{ sent: true }`
   * whether or not the address belongs to anyone. Requiring a token here is
   * impossible — the whole point is that the caller cannot sign in — so the
   * protection is the flat answer plus its own rate-limit budget.
   *
   * The answer is sent *before* the address is looked at, and that ordering is
   * the point rather than an optimisation. Identical bodies are not enough on
   * their own: a registered address costs a document write that an unregistered
   * one does not, and a response that waits for it is a response whose duration
   * carries the answer the body refuses to give. Nothing that depends on the
   * address happens before `res.json` here, so there is no longer a difference
   * to measure.
   *
   * The trade is that a failure has nobody left to report to, so it is logged
   * at error rather than swallowed. That is the right way round for this
   * endpoint: the response was never allowed to describe the outcome anyway,
   * and a 500 would have told the caller about the state of the server without
   * telling them anything they could act on.
   */
  authRouter.post(
    '/forgot-password',
    forgotPasswordLimiter,
    validate(forgotPasswordSchema),
    (req, res) => {
      const { email } = req.body

      res.json({ sent: true })

      requestPasswordReset(email).catch((error) => {
        logger.error({ err: error }, 'password reset request failed after the response was sent')
      })
    }
  )

  // Public: the token itself is the authorisation, exactly as it is for
  // /verify-email. Answers a session, so the client does not have to ask for
  // the password it just set.
  authRouter.post(
    '/reset-password',
    resetPasswordLimiter,
    validate(resetPasswordSchema),
    async (req, res, next) => {
      try {
        const { token, password } = req.body
        res.json(await resetPassword(token, password, deviceFrom(req)))
      } catch (err) {
        next(err)
      }
    }
  )

  authRouter.get('/me', requireAuth, async (req, res, next) => {
    try {
      const user = await User.findById(req.user.id)
      if (!user) throw notFound('User not found')
      res.json({ user: user.toPublic() })
    } catch (err) {
      next(err)
    }
  })

  authRouter.post(
    '/change-password',
    requireAuth,
    passwordChangeLimiter,
    validate(changePasswordSchema),
    async (req, res, next) => {
      try {
        const { currentPassword, newPassword } = req.body
        res.json(await changePassword(req.user.id, currentPassword, newPassword, deviceFrom(req)))
      } catch (err) {
        next(err)
      }
    })

  /**
   * The account's own signed-in devices.
   *
   * `current` marks the one making the request, which is the difference
   * between a usable list and a row of indistinguishable browsers — without it
   * the obvious way to find out which is yours is to sign one out and see.
   */
  authRouter.get('/sessions', requireAuth, async (req, res, next) => {
    try {
      const sessions = await listSessions(req.user.id)
      res.json({
        sessions: sessions.map((session) => ({
          ...session,
          current: session.id === req.user.sessionId,
        })),
      })
    } catch (err) {
      next(err)
    }
  })

  /**
   * Ends every session but this one.
   *
   * Deliberately not "every session": the person pressing it is signed in on
   * the device they are pressing it from, and taking that away as well would
   * answer a request to secure the account by demanding they prove themselves
   * again. Signing this one out is what the sign-out button is for.
   */
  authRouter.delete('/sessions', requireAuth, sessionRevokeLimiter, async (req, res, next) => {
    try {
      res.json(await revokeOtherSessions(req.user.id, req.user.jti))
    } catch (err) {
      next(err)
    }
  })

  /**
   * Ends one session by id.
   *
   * Ownership is part of the query rather than a check after it, so there is
   * no arrangement of ids that reaches somebody else's session — a mismatched
   * owner matches nothing and answers the same 404 as an id that never
   * existed, which also keeps this from confirming that an id belongs to
   * anyone.
   */
  authRouter.delete('/sessions/:sessionId', requireAuth, sessionRevokeLimiter, async (req, res, next) => {
    try {
      res.json(await revokeSession(req.user.id, req.params.sessionId))
    } catch (err) {
      next(err)
    }
  })

  // Authenticated: re-sending needs to know which account, but must not leak
  // whether an arbitrary address is registered.
  authRouter.post('/resend-verification', requireAuth, resendVerificationLimiter, async (req, res, next) => {
    try {
      res.json(await resendVerification(req.user.id))
    } catch (err) {
      next(err)
    }
  })

  return authRouter
}
