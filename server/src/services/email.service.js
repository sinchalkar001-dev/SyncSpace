import { logger } from '../config/logger.js'
import { env } from '../config/env.js'

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
 * Builds the SMTP client from SMTP_URL when one is configured. The import is
 * dynamic so environments without the package (or without a relay at all)
 * pay nothing; a transport that cannot start degrades to logged email rather
 * than taking the API down.
 */
function loadTransport() {
  if (!env.SMTP_URL) return Promise.resolve(null)

  return import('nodemailer')
    .then((nodemailer) => nodemailer.createTransport(env.SMTP_URL))
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
        // No relay configured (development, tests): the message itself is
        // the delivery, so the link stays reachable in the log output.
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
export function sendVerificationEmail(to, { url }) {
  const subject = 'Verify your SyncSpace email'
  const text = [
    'Welcome to SyncSpace.',
    '',
    'Confirm this address by opening the link within 24 hours:',
    url,
    '',
    'If you did not create an account, you can ignore this email.',
  ].join('\n')
  const html =
    '<p>Welcome to SyncSpace.</p>' +
    '<p><a href="' + url + '">Confirm this email address</a> within 24 hours.</p>' +
    '<p>If you did not create an account, you can ignore this email.</p>'

  return mailer.send({ to, subject, text, html })
}
