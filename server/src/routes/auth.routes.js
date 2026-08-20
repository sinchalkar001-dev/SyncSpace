import { Router } from 'express'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { validate } from '../middleware/validate.js'
import { requireAuth } from '../middleware/auth.js'
import { changePassword, login, register } from '../services/auth.service.js'
import { User } from '../models/User.js'
import { notFound } from '../errors.js'

const credentials = z.object({
  email: z.string().email().max(160),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(32).optional(),
})

// Credential endpoints get a much tighter budget than the rest of the API.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts, try again later' } },
})

export const authRouter = Router()

authRouter.post('/register', authLimiter, validate(credentials), async (req, res, next) => {
  try {
    const { email, password, name } = req.body
    res.status(201).json(await register({ email, password, name: name || email.split('@')[0] }))
  } catch (err) {
    next(err)
  }
})

authRouter.post('/login', authLimiter, validate(credentials.omit({ name: true })), async (req, res, next) => {
  try {
    res.json(await login(req.body))
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

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
})

authRouter.post('/change-password', requireAuth, authLimiter, validate(changePasswordSchema), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body
    res.json(await changePassword(req.user.id, currentPassword, newPassword))
  } catch (err) {
    next(err)
  }
})
