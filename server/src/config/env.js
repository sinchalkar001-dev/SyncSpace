import 'dotenv/config'
import { z } from 'zod'

const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

const csv = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))

/**
 * A comma-separated allowlist of absolute origins. Each entry is normalised
 * (trailing slash and default port removed) so it matches exactly what
 * browsers send in the Origin header — "https://app.test/" would otherwise
 * silently never match.
 */
const origins = csv.superRefine((list, ctx) => {
  const issue = (message) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ORIGIN'], message })

  if (!list.length) {
    issue('must list at least one origin')
    return
  }

  list.forEach((origin, index) => {
    if (origin === '*') {
      issue('wildcard "*" is not allowed; list explicit origins instead')
      return
    }

    let url
    try {
      url = new URL(origin)
    } catch {
      issue(`"${origin}" is not an absolute origin (scheme://host[:port])`)
      return
    }

    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      issue(`"${origin}" must be scheme://host[:port] without a path`)
      return
    }

    list[index] = url.origin
  })
})

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    HOST: z.string().default('0.0.0.0'),

    MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/syncspace'),

    JWT_SECRET: z.string().min(32).optional(),
    JWT_EXPIRES_IN: z.string().default('7d'),

    CORS_ORIGIN: origins.optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // Guests may open rooms without an account. Convenient in development,
    // refused outright in production.
    ALLOW_ANONYMOUS: booleanish.default('true'),

    // Append every Yjs update to an immutable log. Required by the replay
    // feature; costs one insert per update, so it can be switched off.
    PERSIST_UPDATE_LOG: booleanish.default('true'),
    PERSIST_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(2000),
    PERSIST_MAX_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(10000),

    // Running a room's buffer executes a real program on this machine. There
    // is no sandbox around it, so it is worth switching off anywhere the
    // people in a room are not people you trust.
    ALLOW_CODE_EXECUTION: booleanish.default('true'),
    RUN_TIMEOUT_MS: z.coerce.number().int().positive().max(60000).default(5000),
    RUN_OUTPUT_LIMIT: z.coerce.number().int().positive().default(65536),
    RUN_MAX_CONCURRENT: z.coerce.number().int().positive().default(4),
    RUN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

    // Credential endpoints get their own, much tighter budgets inside the
    // shared window. Per endpoint rather than one pool so a login brute force
    // cannot starve registration (or vice versa).
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
    AUTH_RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().positive().default(5),
    AUTH_RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
    AUTH_RATE_LIMIT_PASSWORD_CHANGE_MAX: z.coerce.number().int().positive().default(10),

    // Confirming guesses tokens, resending hands out emails; both get their
    // own tight budgets inside the shared auth window.
    AUTH_RATE_LIMIT_VERIFY_MAX: z.coerce.number().int().positive().default(10),
    AUTH_RATE_LIMIT_RESEND_MAX: z.coerce.number().int().positive().default(5),

    // Invites grant room access, so cap them well below the general budget
    // while leaving normal collaboration untouched.
    INVITE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return

    if (!value.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET is required in production (32+ characters)',
      })
    }
    if (value.ALLOW_ANONYMOUS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOW_ANONYMOUS'],
        message: 'ALLOW_ANONYMOUS must be false in production',
      })
    }
    if (!value.CORS_ORIGIN?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGIN'],
        message:
          'CORS_ORIGIN is required in production (comma-separated origins, no wildcards)',
      })
    }
  })

const DEV_SECRET = 'syncspace-development-secret-do-not-use-in-production'

// Convenient local default while developing; production must be explicit.
const DEV_ORIGINS = ['http://localhost:5173']

/** Parses and validates process.env. Throws with a readable report on failure. */
export function loadEnv(source = process.env) {
  const parsed = schema.safeParse(source)

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => '  - ' + issue.path.join('.') + ': ' + issue.message)
      .join('\n')
    throw new Error('Invalid environment configuration:\n' + details)
  }

  return {
    ...parsed.data,
    JWT_SECRET: parsed.data.JWT_SECRET || DEV_SECRET,
    CORS_ORIGIN: parsed.data.CORS_ORIGIN ?? DEV_ORIGINS,
  }
}

export const env = loadEnv()
export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
