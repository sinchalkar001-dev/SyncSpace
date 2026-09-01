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

/**
 * Anything a person typed is escaped before it reaches the HTML part. Room
 * names and display names are free text, and an email client is one more
 * place that will happily render a stray tag.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The room invitation.
 *
 * A private room is invisible to everyone outside it, so this message is the
 * only thing that tells the invitee it exists. It carries both ways in: the
 * link for one click, and the code underneath it, because a code can be typed
 * into the dashboard by someone who would rather not follow a link in an
 * email — and because it is what gets read out loud over a call.
 *
 * `signUpUrl` is set when nobody has signed up under this address yet. The
 * room link would only turn such a person away, so their copy leads with
 * creating the account that the invitation is already waiting on.
 */
export function sendRoomInviteEmail(to, { inviter, room, code, url, signUpUrl = null }) {
  const who = inviter || 'Someone'
  const what = room || code

  const opening = who + ' invited you to collaborate on "' + what + '" in SyncSpace.'
  const subject = who + ' invited you to ' + what + ' on SyncSpace'

  const text = (
    signUpUrl
      ? [
          opening,
          '',
          'Create an account with this address and the room is waiting for you:',
          signUpUrl,
          '',
          'The room itself:',
          url,
          '',
          'Or join from your dashboard with this room code: ' + code,
          '',
          'The invitation is tied to this address, so sign up with it.',
        ]
      : [
          opening,
          '',
          'Open the room:',
          url,
          '',
          'Or go to your dashboard and join with this room code: ' + code,
          '',
          'The room is private, so sign in with this address to get in.',
        ]
  ).join('\n')

  const lead = '<p><strong>' + escapeHtml(who) + '</strong> invited you to collaborate on ' +
    '<strong>' + escapeHtml(what) + '</strong> in SyncSpace.</p>'

  const code_ = '<p>Or join from your dashboard with the room code ' +
    '<strong>' + escapeHtml(code) + '</strong>.</p>'

  const html = signUpUrl
    ? lead +
      '<p><a href="' + escapeHtml(signUpUrl) + '">Create an account</a> with this address and the ' +
      'room is waiting for you.</p>' +
      '<p>The room itself: <a href="' + escapeHtml(url) + '">' + escapeHtml(code) + '</a></p>' +
      code_ +
      '<p>The invitation is tied to this address, so sign up with it.</p>'
    : lead +
      '<p><a href="' + escapeHtml(url) + '">Open the room</a></p>' +
      code_ +
      '<p>The room is private, so sign in with this address to get in.</p>'

  return mailer.send({ to, subject, text, html })
}
