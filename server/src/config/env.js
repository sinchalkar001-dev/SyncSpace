import 'dotenv/config'
import { z } from 'zod'

const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

const csv = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))

/**
 * Where the browsable API documentation lives. One plain path, so it can be
 * renamed or firewalled as a unit; trailing slashes are trimmed away because
 * the mount must not depend on how the operator spelled the variable.
 */
const RESERVED_MOUNTS = ['health', 'api', 'collab', 'socket.io']

const swaggerPath = z
  .string()
  .trim()
  .transform((value) => value.replace(/\/+$/, ''))
  .superRefine((value, ctx) => {
    const issue = (message) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SWAGGER_PATH'], message })

    if (!/^\/\S+$/.test(value)) {
      issue('must start with a single "/" and contain no whitespace')
      return
    }

    const top = value.slice(1).split('/')[0]
    if (RESERVED_MOUNTS.includes(top)) {
      issue(`"${value}" would overlap a reserved route (${RESERVED_MOUNTS.map((r) => '/' + r).join(', ')})`)
    }
  })
  .default('/docs')

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

    // Outbound email. Unset means verification links are logged instead of
    // sent — enough for development; production sets a real relay.
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    CLIENT_URL: z.string().optional(),

    CORS_ORIGIN: origins.optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // The Swagger UI and its OpenAPI document are exposed under one path.
    // Switching SWAGGER_ENABLED off removes every docs route entirely, for
    // deployments that would rather not advertise the API surface at all.
    SWAGGER_ENABLED: booleanish.default('true'),
    SWAGGER_PATH: swaggerPath,

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

    // File uploads. A dedicated budget prevents disk-filling abuse.
    UPLOAD_DIR: z.string().default('./uploads'),
    UPLOAD_MAX_SIZE: z.coerce.number().int().positive().default(10485760), // 10 MB
    UPLOAD_ALLOWED_TYPES: csv.default('image/*,application/pdf,text/*'),
    UPLOAD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
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
  .superRefine((value, ctx) => {
    // The mail relay is a URL that carries credentials, so it is parsed here
    // rather than trusted: a typo fails at boot with a readable report
    // instead of at first send inside nodemailer internals.
    if (value.SMTP_URL) {
      let relay
      try {
        relay = new URL(value.SMTP_URL)
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_URL'],
          message: 'SMTP_URL must be a URL (smtp://host[:port] or smtps://user:pass@host[:port])',
        })
        relay = null
      }
      if (relay && relay.protocol !== 'smtp:' && relay.protocol !== 'smtps:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_URL'],
          message: 'SMTP_URL must use the smtp: or smtps: scheme',
        })
      }
      if (relay && !value.MAIL_FROM) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MAIL_FROM'],
          message: 'MAIL_FROM is required when SMTP_URL is set',
        })
      }
    }

    // Where emailed links point. Optional because it defaults to the first
    // allowed origin — usually the same app.
    if (value.CLIENT_URL) {
      let link
      try {
        link = new URL(value.CLIENT_URL)
      } catch {
        link = null
      }
      if (
        !link ||
        (link.protocol !== 'http:' && link.protocol !== 'https:') ||
        link.pathname !== '/' ||
        link.search ||
        link.hash
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CLIENT_URL'],
          message: 'CLIENT_URL must be scheme://host[:port] without a path',
        })
      }
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

  const corsOrigin = parsed.data.CORS_ORIGIN ?? DEV_ORIGINS

  return {
    ...parsed.data,
    JWT_SECRET: parsed.data.JWT_SECRET || DEV_SECRET,
    CORS_ORIGIN: corsOrigin,
    // Emailed links land on the client; the first allowed origin is the same
    // app in every deployment we run.
    CLIENT_URL: parsed.data.CLIENT_URL || corsOrigin[0],
  }
}

export const env = loadEnv()
export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
