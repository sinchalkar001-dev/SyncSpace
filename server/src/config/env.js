import dotenv from 'dotenv'
import { z } from 'zod'

/**
 * Tests get the environment the suite declares, never the developer's own.
 *
 * A configured relay would otherwise make `npm test` send real email through a
 * personal account — the suite registers dozens of them — and the verification
 * tests read their token out of the logged message, which only happens while
 * nothing is configured. Pinning values one at a time in vitest.config.js only
 * ever covers the ones somebody already got caught by.
 */
if (process.env.NODE_ENV !== 'test') dotenv.config()

/**
 * An emptied setting means "not configured", not "configured with nothing".
 * Clearing a value is the obvious way to turn one off, and it should not fail
 * at boot with a complaint about length.
 */
const blankIsUnset = (schema) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema)

const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

const csv = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))

/**
 * A small `{"key": "value"}` map in one variable.
 *
 * Used for per-language container image overrides, where the alternative is
 * seven variables that all have to be spelled correctly. Bad JSON is a
 * configuration mistake worth failing at boot for, rather than one that
 * surfaces as a mysteriously missing language later.
 */
const jsonRecord = blankIsUnset(
  z
    .string()
    .transform((value, ctx) => {
      try {
        const parsed = JSON.parse(value)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object')
        }
        return parsed
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a JSON object of strings' })
        return z.NEVER
      }
    })
    .pipe(z.record(z.string()))
    .optional()
)

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

    // Outbound email, given either way round: one relay URL, or the four
    // parts a provider actually hands you. Neither set means messages are
    // logged instead of sent — enough for development; production sets a relay.
    SMTP_URL: blankIsUnset(z.string().optional()),

    SMTP_HOST: blankIsUnset(z.string().trim().min(1).optional()),
    SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
    SMTP_USER: blankIsUnset(z.string().trim().min(1).optional()),
    /**
     * Gmail prints an app password in four groups of four. The spaces are
     * presentation — the relay refuses them — and everybody pastes what they
     * were shown, so they come off here rather than in a support thread.
     */
    SMTP_PASS: blankIsUnset(
      z
        .string()
        .transform((value) => value.replace(/\s+/g, ''))
        .pipe(z.string().min(1))
        .optional()
    ),
    // TLS from the first byte (port 465). Left unset it follows the port,
    // which is what every provider's instructions assume.
    SMTP_SECURE: booleanish.optional(),

    /**
     * Who the mail comes from.
     *
     * Split in two because the name and the address are different things and
     * only one of them is an identity: SyncSpace sends as exactly one address,
     * and a relay only accepts a From it recognises anyway. `MAIL_FROM` is
     * still read when set, so existing deployments keep working — it simply
     * takes precedence over the pair.
     */
    MAIL_FROM_NAME: z.string().trim().default('SyncSpace'),
    MAIL_FROM_EMAIL: blankIsUnset(z.string().trim().email().optional()),
    MAIL_FROM: blankIsUnset(z.string().optional()),

    /**
     * `mock` keeps every message in memory instead of sending it, and exposes
     * the last one so a test can read the code out of it. Refused in
     * production: a deployment that silently stopped sending mail would look
     * healthy right up until somebody could not sign in.
     */
    EMAIL_PROVIDER: z.enum(['smtp', 'mock']).default('smtp'),

    CLIENT_URL: z.string().optional(),

    /**
     * How long proof of an address stays good for.
     *
     * Two numbers because they are two different risks. The link is a 256-bit
     * secret nobody can guess, so it can afford half an hour; the code is six
     * digits somebody could sit and try, so it expires sooner and is bounded
     * by an attempt count as well.
     */
    EMAIL_VERIFICATION_TOKEN_EXPIRY_MINUTES: z.coerce.number().int().positive().max(1440).default(30),
    EMAIL_VERIFICATION_CODE_EXPIRY_MINUTES: z.coerce.number().int().positive().max(120).default(10),

    /**
     * Guessing budget for the six-digit code, and the wait between emails.
     *
     * A million combinations sounds like plenty until somebody scripts it.
     * Five attempts makes the code worthless as a guessing target, and the
     * cooldown stops the resend button being a way to mail-bomb an address.
     */
    EMAIL_VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),
    EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().max(3600).default(60),

    /**
     * Whether an unverified account may sign in.
     *
     * Off, because turning it on locks out every account that has not verified
     * yet — including every account created before verification was enforced.
     * Production turns it on deliberately, once the people who need to verify
     * have had the chance.
     */
    REQUIRE_EMAIL_VERIFICATION: booleanish.default('false'),

    /** How long a room invitation stays acceptable. A week, by default. */
    INVITATION_EXPIRY_HOURS: z.coerce.number().int().positive().max(8760).default(168),

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

    // Running a room's buffer executes a program somebody else wrote. How
    // much that is worth worrying about depends entirely on SANDBOX_BACKEND
    // below; this switch turns the whole feature off.
    ALLOW_CODE_EXECUTION: booleanish.default('true'),
    RUN_TIMEOUT_MS: z.coerce.number().int().positive().max(60000).default(5000),
    RUN_OUTPUT_LIMIT: z.coerce.number().int().positive().default(65536),
    RUN_MAX_CONCURRENT: z.coerce.number().int().positive().default(4),
    RUN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),

    /**
     * How a program is isolated from the machine it runs on.
     *
     *   docker   a container per run, and if there is no container runtime
     *            then nothing runs at all
     *   process  a child process on this machine, which is not a sandbox
     *   auto     containers when available, a child process otherwise
     *
     * `auto` is the default so the feature works on a laptop with nothing
     * installed. Production wants `docker`, and the difference is not
     * cosmetic: `auto` on a host where the daemon is down silently becomes
     * `process`, which runs untrusted code with the server's own filesystem
     * and network access. `docker` refuses instead.
     */
    SANDBOX_BACKEND: z.enum(['auto', 'docker', 'process']).default('auto'),
    SANDBOX_DOCKER_BIN: z.string().trim().min(1).default('docker'),

    // Per run. A memory limit and a process limit are what turn "allocate
    // until the machine swaps" and a fork bomb into an ordinary failed run.
    SANDBOX_MEMORY_MB: z.coerce.number().int().positive().max(16384).default(256),
    SANDBOX_CPUS: z.coerce.number().positive().max(64).default(1),
    SANDBOX_PIDS: z.coerce.number().int().positive().max(4096).default(64),
    SANDBOX_FILE_SIZE_MB: z.coerce.number().int().positive().max(4096).default(32),

    /**
     * Off, and it takes a deliberate act to change that.
     *
     * A program with a network is a program that can reach the cloud metadata
     * endpoint that hands out credentials, scan the private network the server
     * sits in, and post whatever it finds somewhere else. None of that is
     * exotic; it is the first thing anyone tries.
     */
    SANDBOX_NETWORK: booleanish.default('false'),
    SANDBOX_NETWORK_NAME: z.string().trim().min(1).default('bridge'),

    // Never root. Left unset it follows the server's own uid, which is what
    // makes the bind-mounted working directory writable.
    SANDBOX_USER: blankIsUnset(z.string().trim().optional()),
    // For gVisor or Kata, where a deployment wants a second boundary under
    // the first.
    SANDBOX_RUNTIME: blankIsUnset(z.string().trim().optional()),
    // Whether a language counts as available before its image is local.
    SANDBOX_PULL: booleanish.default('false'),
    SANDBOX_IMAGES: jsonRecord,

    /**
     * Admission, not just capacity.
     *
     * RUN_MAX_CONCURRENT alone is first-come-first-served, so one person with
     * a script can hold every slot indefinitely and everybody else is refused.
     * These two make that a slower turn for the person doing it rather than an
     * outage for everyone else.
     */
    SANDBOX_MAX_PER_USER: z.coerce.number().int().positive().default(2),
    SANDBOX_MAX_PER_ROOM: z.coerce.number().int().positive().default(4),
    SANDBOX_QUEUE_DEPTH: z.coerce.number().int().positive().default(32),

    // Program output is whatever someone typed into a shared editor. Keeping
    // it forever is a liability; keeping it briefly is what lets the console
    // survive a reload.
    SANDBOX_RETENTION_HOURS: z.coerce.number().int().positive().max(8760).default(24),

    // Cancelling has its own budget: sharing the run budget would mean that
    // exhausting it leaves you unable to stop the programs you already
    // started, which is when stopping them matters most.
    SANDBOX_CANCEL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

    /**
     * Turning a whiteboard into code calls a model, which costs money per
     * request and is the only thing here that reaches outside this machine.
     * With no key the feature reports itself unavailable and explains why,
     * exactly as a missing compiler does on /runners — the UI never offers a
     * button that cannot work.
     */
    AI_ENABLED: booleanish.default('true'),

    /**
     * One key, either vendor.
     *
     * Which service to call is worked out from the key itself — Anthropic's
     * begin `sk-ant-`, Google's begin `AIza` — because that is a fact about
     * the credential rather than a second setting to keep in step with it. A
     * mismatched pair is the kind of misconfiguration that fails at the first
     * request with an unhelpful 401, and there is no reason to invite it.
     * `AI_PROVIDER` overrides the guess for anything self-hosted.
     */
    ANTHROPIC_API_KEY: blankIsUnset(z.string().trim().min(1).optional()),
    GOOGLE_API_KEY: blankIsUnset(z.string().trim().min(1).optional()),
    AI_PROVIDER: z.enum(['anthropic', 'google']).optional(),

    // Left unset, each provider's own default endpoint and model are used.
    AI_BASE_URL: blankIsUnset(z.string().url().optional()),
    AI_MODEL: blankIsUnset(z.string().trim().min(1).optional()),
    // A whole change set in one answer; below about 4k the last file is
    // routinely cut off, which costs the request and produces nothing.
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(64000).default(8000),
    /**
     * Generation holds an HTTP request open, so this is the ceiling on how
     * long somebody watches a spinner before being told it failed.
     *
     * Three minutes rather than two, from measurement: a single-target run
     * against gemini-3.6-flash took 112s while the provider was busy enough
     * to be answering 503s elsewhere. A 120s cap would have failed that after
     * doing all the work and paying for it, and four targets at once is a
     * larger answer than one.
     */
    AI_TIMEOUT_MS: z.coerce.number().int().positive().max(600000).default(180000),
    // Far tighter than the general budget: each call is a real cost.
    AI_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

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

    // Password recovery, split the same way: asking hands out an email to
    // somebody else's address, so it is budgeted like resending, while
    // spending a reset token is a guess at 256 bits and budgeted like
    // confirming. Sharing one budget would let a flood of requests for other
    // people's addresses lock a legitimate user out of finishing their own.
    AUTH_RATE_LIMIT_FORGOT_MAX: z.coerce.number().int().positive().default(5),
    AUTH_RATE_LIMIT_RESET_MAX: z.coerce.number().int().positive().default(10),

    // Signing devices out. Higher than the rest of this group because it is
    // authenticated and can only reach the caller's own sessions, so it is
    // capped against repeated connection-closing work rather than guessing.
    AUTH_RATE_LIMIT_SESSION_REVOKE_MAX: z.coerce.number().int().positive().default(30),

    // Invites grant room access, so cap them well below the general budget
    // while leaving normal collaboration untouched.
    INVITE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

    // File uploads. A dedicated budget prevents disk-filling abuse.
    UPLOAD_DIR: z.string().default('./uploads'),
    UPLOAD_MAX_SIZE: z.coerce.number().int().positive().default(10485760), // 10 MB
    UPLOAD_ALLOWED_TYPES: csv.default('image/*,application/pdf,text/*'),
    UPLOAD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

    // Optional Redis instance for shared rate-limit counters across multiple
    // server processes. When unset the in-memory default store is used instead,
    // which is fine for single-node deployments.
    REDIS_URL: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return

    /**
     * A production deployment must never quietly stop sending mail.
     *
     * The mock transport is how the tests read a verification code without a
     * relay. In production it would mean every verification email vanishing
     * into memory while the API answered `{ sent: true }` — an outage that
     * looks exactly like everything working, until nobody can sign in.
     */
    if (value.EMAIL_PROVIDER === 'mock') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_PROVIDER'],
        message: 'EMAIL_PROVIDER=mock does not send email and is refused in production',
      })
    }

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
    const issue = (path, message) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message })

    // The relay URL carries credentials, so it is parsed here rather than
    // trusted: a typo fails at boot with a readable report instead of at first
    // send inside nodemailer internals.
    if (value.SMTP_URL) {
      let relay
      try {
        relay = new URL(value.SMTP_URL)
      } catch {
        issue('SMTP_URL', 'SMTP_URL must be a URL (smtp://host[:port] or smtps://user:pass@host[:port])')
        relay = null
      }
      if (relay && relay.protocol !== 'smtp:' && relay.protocol !== 'smtps:') {
        issue('SMTP_URL', 'SMTP_URL must use the smtp: or smtps: scheme')
      }
    }

    // Two relays are not better than one, and which would win is nobody's
    // guess but this file's.
    if (value.SMTP_URL && value.SMTP_HOST) {
      issue('SMTP_HOST', 'set either SMTP_URL or SMTP_HOST, not both')
    }

    // Half a login fails at the relay rather than at boot, and looks from the
    // outside exactly like a wrong password.
    if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASS)) {
      issue('SMTP_PASS', 'SMTP_USER and SMTP_PASS go together — set both, or neither')
    }

    // Every relay needs a From it will accept. A username that is already an
    // address stands in for one, which covers Gmail and most of the rest.
    if ((value.SMTP_URL || value.SMTP_HOST) && !value.MAIL_FROM && !value.SMTP_USER?.includes('@')) {
      issue('MAIL_FROM', 'MAIL_FROM is required unless SMTP_USER is itself an address')
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
    // Implicit TLS is port 465's whole distinction; everything else starts
    // plain and upgrades with STARTTLS.
    SMTP_SECURE: parsed.data.SMTP_SECURE ?? parsed.data.SMTP_PORT === 465,
    // Emailed links land on the client; the first allowed origin is the same
    // app in every deployment we run.
    CLIENT_URL: parsed.data.CLIENT_URL || corsOrigin[0],

    /**
     * The From header, assembled once here rather than at each send.
     *
     * An explicit MAIL_FROM still wins, so deployments that set it keep
     * working unchanged. Otherwise it is built from the name and the address,
     * and falls back to the SMTP login — which for Gmail is the address
     * anyway, and is the only From that relay will accept.
     */
    MAIL_FROM:
      parsed.data.MAIL_FROM ||
      (parsed.data.MAIL_FROM_EMAIL
        ? parsed.data.MAIL_FROM_NAME + ' <' + parsed.data.MAIL_FROM_EMAIL + '>'
        : parsed.data.SMTP_USER
          ? parsed.data.MAIL_FROM_NAME + ' <' + parsed.data.SMTP_USER + '>'
          : undefined),
  }
}

export const env = loadEnv()
export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
