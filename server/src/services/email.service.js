import { logger } from '../config/logger.js'
import { env } from '../config/env.js'
import {
  invitationEmail,
  passwordResetEmail,
  verificationEmail,
} from './email.templates.js'

/**
 * Hides the local part of an address before anything reaches the logs.
 * Full addresses are personal data; logs are read far more widely than mail.
 */
export function maskEmail(address) {
  const at = typeof address === 'string' ? address.lastIndexOf('@') : -1
  if (at <= 0) return '***'
  return address[0] + '***' + address.slice(at)
}

/**
 * What nodemailer should be handed, or null when no relay is configured.
 *
 * Exported because the mail-check script asks the same question, and a
 * diagnostic that built its own idea of the relay could pass while the app
 * it is meant to vouch for goes on failing.
 */
export function relayOptions() {
  if (env.SMTP_URL) return env.SMTP_URL
  if (!env.SMTP_HOST) return null

  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    // Relays on a private network often want no login at all; sending an
    // empty one is not the same as sending none.
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  }
}

/**
 * Builds the SMTP client from whatever relay is configured. The import is
 * dynamic so environments without the package (or without a relay at all)
 * pay nothing; a transport that cannot start degrades to logged email rather
 * than taking the API down.
 */
function loadTransport() {
  /**
   * `mock` is decided here rather than at send time, so that a transport
   * handed to `createMailer` explicitly is still used. That injection is the
   * seam the mailer's own tests rely on, and a provider check inside `send`
   * overrode it — the tests then proved the mock worked rather than the mailer.
   */
  if (env.EMAIL_PROVIDER === 'mock') return Promise.resolve(null)

  const relay = relayOptions()
  if (!relay) return Promise.resolve(null)

  return import('nodemailer')
    .then((nodemailer) => nodemailer.createTransport(relay))
    .catch((err) => {
      // Only the error class is logged: connection errors can echo relay
      // banners, and the URL itself carries the credentials.
      logger.error(
        { code: err.code ?? err.name },
        'SMTP transport unavailable, falling back to logging emails'
      )
      return null
    })
}

const defaultTransport = loadTransport()

/**
 * The last few messages that were composed but not actually sent.
 *
 * Only filled when nothing is being delivered — `EMAIL_PROVIDER=mock`, or no
 * relay configured at all. It exists so a test can read the verification code
 * out of the message instead of scraping it from log output, which was how
 * this suite used to do it: a test that parses a log line breaks when somebody
 * improves the wording, and quietly stops checking anything when it does.
 *
 * Bounded, because an unbounded list of every email a long-running development
 * server has composed is a memory leak with personal data in it.
 */
const OUTBOX_LIMIT = 50
const outbox = []

const capture = (message) => {
  outbox.push({ ...message, at: new Date() })
  if (outbox.length > OUTBOX_LIMIT) outbox.shift()
}

/** The most recent message, or the most recent one to `address`. */
export function lastMessage(address) {
  const match = address
    ? [...outbox].reverse().find((message) => message.to === address)
    : outbox[outbox.length - 1]
  return match ?? null
}

export const clearOutbox = () => {
  outbox.length = 0
}

/**
 * Creates a mailer over a transport. Injected in tests; the app-wide instance
 * is `mailer` below. Every failure mode ends here, so callers get a plain
 * `{ delivered }` answer instead of an exception carrying provider internals.
 */
export function createMailer({ transport = defaultTransport, from = env.MAIL_FROM } = {}) {
  return {
    /**
     * Sends one message. Resolves `{ delivered: true|false }` and never
     * throws: an outage is retried by the user pressing "resend", not by
     * failing whatever request happened to trigger the email.
     */
    async send({ to, subject, text, html }) {
      const client = await transport

      if (!client) {
        /**
         * Nothing is being sent, so the message itself is the delivery: it
         * goes to the log where a developer can follow the link, and to the
         * outbox where a test can read the code.
         *
         * `EMAIL_PROVIDER=mock` arrives here as a null transport, which is
         * what lets the suite run on a machine holding real credentials
         * without mailing anybody. Production refuses the setting outright —
         * see env.js.
         */
        capture({ to, subject, text, html })
        logger.info({ to: maskEmail(to), subject }, text)
        return { delivered: false }
      }

      try {
        await client.sendMail({ from, to, subject, text, html })
        return { delivered: true }
      } catch (err) {
        // Same discipline on failures: masked recipient, error code only.
        logger.warn(
          { to: maskEmail(to), subject, code: err.code ?? err.name },
          'email delivery failed'
        )
        return { delivered: false }
      }
    },
  }
}

export const mailer = createMailer()

/**
 * The account confirmation message. `url` is the signed-off link produced by
 * the verification service; everything else here is presentation, kept in
 * one place so future emails reuse the same frame.
 */
/**
 * Account confirmation.
 *
 * Takes the code and both expiries rather than writing them here, so the
 * message cannot promise a window the service does not actually enforce —
 * which is exactly what happened before: the text said 24 hours because a
 * constant elsewhere said 24 hours, and nothing connected the two.
 */
export function sendVerificationEmail(to, { url, code, tokenMinutes, codeMinutes }) {
  return mailer.send({ to, ...verificationEmail({ url, code, tokenMinutes, codeMinutes }) })
}

/**
 * The password reset message.
 *
 * Says plainly that the account is untouched until the link is used, and that
 * ignoring the message is a complete answer. Someone who did not ask for this
 * has just learned that a stranger typed their address into a login page, and
 * the useful thing to tell them is that nothing has happened yet.
 *
 * `minutes` is passed in rather than written here so the text cannot drift
 * away from the expiry the service actually enforces.
 */
export function sendPasswordResetEmail(to, { url, minutes }) {
  return mailer.send({ to, ...passwordResetEmail({ url, minutes }) })
}

/**
 * A room invitation.
 *
 * A private room is invisible to everyone outside it, so this message is the
 * only thing that tells the invitee it exists. `signUpUrl` is set when nobody
 * has signed up under this address yet: the room link would only turn such a
 * person away, so their copy leads with creating the account the invitation is
 * already waiting on.
 *
 * `code` is still accepted so existing callers keep working, but the link is
 * what the invitation is now tied to — see invitation.service.js.
 */
export function sendRoomInviteEmail(to, { inviter, room, code, url, signUpUrl = null, hours }) {
  return mailer.send({
    to,
    ...invitationEmail({
      inviter,
      room,
      code,
      url,
      signUpUrl,
      hours: hours ?? env.INVITATION_EXPIRY_HOURS,
    }),
  })
}
