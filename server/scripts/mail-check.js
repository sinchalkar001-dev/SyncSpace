/**
 * Proves the mail relay works, before an invitation depends on it.
 *
 *   node scripts/mail-check.js you@example.com
 *
 * The app deliberately swallows delivery failures — an invite that worked must
 * not be reported as broken because a relay was slow — which leaves nowhere to
 * see *why* nothing arrived. This is that place: it reuses the app's own relay
 * settings, then reports the provider's actual answer instead of hiding it.
 */
import { env } from '../src/config/env.js'
import { maskEmail, relayOptions } from '../src/services/email.service.js'

const to = process.argv[2]

const die = (message) => {
  process.stderr.write(message + '\n')
  process.exit(1)
}

if (!to || !to.includes('@')) {
  die('Usage: node scripts/mail-check.js you@example.com')
}

const relay = relayOptions()

if (!relay) {
  die(
    [
      'No mail relay is configured, so SyncSpace logs messages instead of sending them.',
      '',
      'Set SMTP_HOST / SMTP_USER / SMTP_PASS in server/.env — see server/.env.example',
      'for a Gmail-ready block — then run this again.',
    ].join('\n')
  )
}

/** Everything printable about the relay, and nothing that is a secret. */
function describe() {
  if (typeof relay === 'string') {
    const url = new URL(relay)
    return {
      where: url.hostname + ':' + (url.port || (url.protocol === 'smtps:' ? '465' : '587')),
      how: url.protocol === 'smtps:' ? 'implicit TLS' : 'STARTTLS',
      as: url.username ? maskEmail(decodeURIComponent(url.username)) : 'no login',
    }
  }

  return {
    where: relay.host + ':' + relay.port,
    how: relay.secure ? 'implicit TLS' : 'STARTTLS',
    as: relay.auth ? maskEmail(relay.auth.user) : 'no login',
  }
}

const { where, how, as } = describe()
process.stdout.write(
  ['relay:  ' + where + ' (' + how + ')', 'as:     ' + as, 'from:   ' + env.MAIL_FROM, ''].join('\n') + '\n'
)

/**
 * Gmail is where most of these land, and its errors say what is wrong without
 * saying what to do about it. Each of these costs an evening to work out once.
 */
function advise(error) {
  const code = error?.code
  const text = String(error?.message || '')

  if (code === 'EAUTH' || /535|Username and Password not accepted/i.test(text)) {
    return [
      'The relay refused the login.',
      'For Gmail this is almost always the password: a normal account password',
      'will not work here. Turn on 2-Step Verification, then generate an App',
      'Password at https://myaccount.google.com/apppasswords and use that as',
      'SMTP_PASS. Paste it however Google shows it — the spaces come out here.',
    ].join('\n')
  }

  if (code === 'ESOCKET' || code === 'ECONNECTION' || code === 'ETIMEDOUT') {
    return [
      'Could not open a connection to the relay.',
      'Check SMTP_HOST and SMTP_PORT, and whether outbound SMTP is blocked here —',
      'some networks and hosting providers close port 587 and 465 by default.',
    ].join('\n')
  }

  if (/self.signed|unable to verify|certificate/i.test(text)) {
    return 'The relay presented a certificate this machine does not trust. Check SMTP_HOST is spelled as the provider gives it.'
  }

  return null
}

const { createTransport } = await import('nodemailer')
const transport = createTransport(relay)

try {
  process.stdout.write('connecting... ')
  await transport.verify()
  process.stdout.write('ok\n')

  process.stdout.write('sending to ' + maskEmail(to) + '... ')
  const receipt = await transport.sendMail({
    from: env.MAIL_FROM,
    to,
    subject: 'SyncSpace mail check',
    text: [
      'This is the SyncSpace mail check.',
      '',
      'If you are reading it, invitations will reach people too.',
    ].join('\n'),
  })

  process.stdout.write('sent\n')
  process.stdout.write('\nmessage id: ' + receipt.messageId + '\n')
  if (receipt.accepted?.length) process.stdout.write('accepted for: ' + receipt.accepted.length + ' recipient(s)\n')
  if (receipt.rejected?.length) process.stdout.write('REJECTED: ' + receipt.rejected.join(', ') + '\n')
} catch (error) {
  process.stdout.write('failed\n\n')

  // The point of this script: the provider's own words, not a masked summary.
  process.stderr.write((error.code ? error.code + ': ' : '') + error.message + '\n')

  const hint = advise(error)
  if (hint) process.stderr.write('\n' + hint + '\n')
  process.exit(1)
} finally {
  transport.close()
}
