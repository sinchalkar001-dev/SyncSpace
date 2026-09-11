import rateLimit from 'express-rate-limit'
import { env } from '../config/env.js'
import { getRedisClient } from '../config/redis.js'
import { logger } from '../config/logger.js'

/**
 * Every limiter in the app is built here so headers, keying and the error
 * body stay identical. All budgets are per IP within the window.
 *
 * When REDIS_URL is set, counters are stored in Redis so multiple server
 * processes share a single budget per IP. Without Redis the default
 * in-memory store is used instead.
 */
let sharedStore = undefined

/**
 * Connects to Redis (if REDIS_URL is set) and creates a shared rate-limit
 * store. Must be called once before createApp(); safe to call when REDIS_URL
 * is not configured — it becomes a no-op.
 */
export async function initRateLimitStore() {
  if (!env.REDIS_URL) return

  try {
    const client = await getRedisClient()
    if (!client) return

    const { RedisStore } = await import('rate-limit-redis')
    sharedStore = new RedisStore({
      sendCommand: (...args) => client.sendCommand(args),
    })
    logger.info('rate-limit store: redis')
  } catch (err) {
    logger.warn({ err }, 'failed to initialise Redis rate-limit store; using in-memory')
  }
}

export function createRateLimiters() {
  const build = ({ windowMs, max, message }) =>
    rateLimit({
      windowMs,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { code: 'rate_limited', message } },
      store: sharedStore,
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

    /**
     * Stopping a program, budgeted separately and generously.
     *
     * Sharing the run budget would mean that the moment somebody exhausts it,
     * they can no longer cancel the programs they already started — the exact
     * situation where cancelling matters most. Ending a run also costs less
     * than starting one.
     */
    cancelLimiter: build({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.SANDBOX_CANCEL_RATE_LIMIT_MAX,
      message: 'Too many cancellations from this address, try again later',
    }),

    /**
     * Each generation is a paid call to a model and the slowest request this
     * server serves. Capped well below everything else, because the cost of
     * abuse here is a bill rather than load.
     */
    generateLimiter: build({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.AI_RATE_LIMIT_MAX,
      message: 'Too many generations from this address, try again later',
    }),

    /** File uploads are expensive (disk I/O, bandwidth); cap them separately. */
    commentLimiter: build({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.COMMENT_RATE_LIMIT_MAX,
      message: 'Too many comments, try again shortly',
    }),

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
    forgotPasswordLimiter: auth(
      env.AUTH_RATE_LIMIT_FORGOT_MAX,
      'Too many password reset emails requested, try again later'
    ),
    resetPasswordLimiter: auth(
      env.AUTH_RATE_LIMIT_RESET_MAX,
      'Too many password reset attempts, try again later'
    ),
    /**
     * Signing devices out. Authenticated and scoped to the caller's own
     * account, so this is not a brute-force surface — it is capped because
     * each call can close live connections, and a loop over it would be a
     * cheap way to make the server do that work over and over.
     */
    sessionRevokeLimiter: auth(
      env.AUTH_RATE_LIMIT_SESSION_REVOKE_MAX,
      'Too many sign-out requests, try again later'
    ),
  }
}
