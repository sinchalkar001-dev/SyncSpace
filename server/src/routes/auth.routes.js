import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../middleware/validate.js'
import { requireAuth } from '../middleware/auth.js'
import { createRateLimiters } from '../middleware/rateLimit.js'
import { changePassword, login, register } from '../services/auth.service.js'
import { resendVerification, verifyEmail } from '../services/verification.service.js'
import { User } from '../models/User.js'
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
const verificationSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, 'malformed verification token'),
})

export function createAuthRouter() {
  const authRouter = Router()
  const {
    registerLimiter,
    loginLimiter,
    passwordChangeLimiter,
    verifyLimiter,
    resendVerificationLimiter,
  } = createRateLimiters()

  authRouter.post('/register', registerLimiter, validate(credentials), async (req, res, next) => {
    try {
      const { email, password, name } = req.body
      res.status(201).json(await register({ email, password, name: name || email.split('@')[0] }))
    } catch (err) {
      next(err)
    }
  })

  authRouter.post('/login', loginLimiter, validate(credentials.omit({ name: true })), async (req, res, next) => {
    try {
      res.json(await login(req.body))
    } catch (err) {
      next(err)
    }
  })

  // Public: the token itself proves control of the address.
  authRouter.post('/verify-email', verifyLimiter, validate(verificationSchema), async (req, res, next) => {
    try {
      const user = await verifyEmail(req.body.token)
      res.json({ user: user.toPublic() })
    } catch (err) {
      next(err)
    }
  })

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
      res.json(await changePassword(req.user.id, currentPassword, newPassword))
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
