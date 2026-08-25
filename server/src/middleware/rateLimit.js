import rateLimit from 'express-rate-limit'
import { env } from '../config/env.js'

/**
 * Every limiter in the app is built here so headers, keying and the error
 * body stay identical. All budgets are per IP within the window.
 *
 * Limiters hold their counters in memory, so they must be created once per
 * app instance (not at module scope): rebuilding the app starts every
 * budget from zero again.
 */
export function createRateLimiters() {
  const build = ({ windowMs, max, message }) =>
    rateLimit({
      windowMs,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { code: 'rate_limited', message } },
    })

  const general = {
    /** Generous budget for the whole REST API; normal usage never hits it. */
    apiLimiter: build({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      message: 'Too many requests, try again later',
    }),

    /** Invites hand out room access; capped separately from everyday room reads. */
    inviteLimiter: build({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.INVITE_RATE_LIMIT_MAX,
      message: 'Too many invites sent, try again later',
    }),

    /** Each run costs a process; far cheaper to refuse than to fork. */
    runLimiter: build({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RUN_RATE_LIMIT_MAX,
      message: 'Too many runs from this address, try again later',
    }),

    /** File uploads are expensive (disk I/O, bandwidth); cap them separately. */
    uploadLimiter: build({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.UPLOAD_RATE_LIMIT_MAX,
      message: 'Too many file uploads from this address, try again later',
    }),
  }

  // Credential endpoints share one window but each has its own budget, so a
  // login brute force cannot starve registration (or vice versa).
  const auth = (max, message) => build({ windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS, max, message })

  return {
    ...general,
    registerLimiter: auth(
      env.AUTH_RATE_LIMIT_REGISTER_MAX,
      'Too many sign-up attempts from this address, try again later'
    ),
    loginLimiter: auth(env.AUTH_RATE_LIMIT_LOGIN_MAX, 'Too many login attempts, try again later'),
    passwordChangeLimiter: auth(
      env.AUTH_RATE_LIMIT_PASSWORD_CHANGE_MAX,
      'Too many password changes, try again later'
    ),
    verifyLimiter: auth(
      env.AUTH_RATE_LIMIT_VERIFY_MAX,
      'Too many verification attempts, try again later'
    ),
    resendVerificationLimiter: auth(
      env.AUTH_RATE_LIMIT_RESEND_MAX,
      'Too many verification emails requested, try again later'
    ),
  }
}
