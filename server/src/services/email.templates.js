import { env } from '../config/env.js'

/**
 * What SyncSpace's transactional email looks like.
 *
 * Separated from the sending because they change for different reasons and by
 * different people: the frame and the wording are a design decision, while
 * relays, retries and failure handling are an infrastructure one. Mixing them
 * is how a copy change ends up in a commit that also touches SMTP.
 *
 * Every template returns `{ subject, text, html }`. The plain-text version is
 * not a courtesy — a message with no text part is scored as spam by most
 * filters, and the one thing these emails cannot afford is to be filed as
 * junk, because the whole point is proving somebody can read them.
 */

/** Anything interpolated into HTML goes through here. Names are user input. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The shell every message shares.
 *
 * Tables and inline styles, which looks like 2004 and is: Outlook still lays
 * out with a Word engine, and Gmail strips `<style>` blocks. This renders the
 * same in both, and degrades to something readable in the handful of clients
 * that render neither.
 */
function frame({ heading, body, action, footnote }) {
  const button = action
    ? `
      <tr>
        <td style="padding:8px 0 24px">
          <a href="${escapeHtml(action.url)}"
             style="display:inline-block;padding:12px 22px;border-radius:8px;
                    background:#e8a33d;color:#1a1614;text-decoration:none;
                    font-weight:600;font-size:15px">${escapeHtml(action.label)}</a>
        </td>
      </tr>`
    : ''

  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#12100f;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#12100f;padding:32px 16px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="max-width:520px;background:#1a1716;border:1px solid #2c2724;
                      border-radius:14px;padding:32px">
          <tr>
            <td style="padding-bottom:20px;color:#e8a33d;font-size:18px;font-weight:700;
                       letter-spacing:0.01em">SyncSpace</td>
          </tr>
          <tr>
            <td style="padding-bottom:12px;color:#f2ece7;font-size:20px;font-weight:600">
              ${escapeHtml(heading)}
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:20px;color:#b9afa7;font-size:15px;line-height:1.55">
              ${body}
            </td>
          </tr>
          ${button}
          <tr>
            <td style="padding-top:20px;border-top:1px solid #2c2724;color:#7d746d;
                       font-size:13px;line-height:1.5">
              ${footnote}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/** The code, shown as something a person can read off a screen and retype. */
const codeBlock = (code) => `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px">
    <tr>
      <td style="padding:14px 20px;border:1px solid #2c2724;border-radius:10px;
                 background:#12100f;color:#f2ece7;font-family:'SFMono-Regular',Consolas,monospace;
                 font-size:26px;letter-spacing:0.28em;font-weight:600">${escapeHtml(code)}</td>
    </tr>
  </table>`

const SECURITY_NOTE =
  'SyncSpace will never ask you for this code. Do not forward this email or share the code with anyone.'

/**
 * Account confirmation: the link and the code, in one message.
 *
 * Both, because they suit different situations — the link is one tap on the
 * device holding the mailbox, and the code is what you use when the email is
 * on your phone and SyncSpace is open on a laptop. Sending only the link makes
 * the second case an exercise in retyping a 64-character token.
 */
export function verificationEmail({ url, code, tokenMinutes, codeMinutes }) {
  const subject = 'Verify your SyncSpace email address'

  const text = [
    'Welcome to SyncSpace!',
    '',
    'Please verify your email address to activate your account.',
    '',
    'Verify by opening this link:',
    url,
    '',
    'Or enter this verification code:',
    code,
    '',
    'The code expires in ' + codeMinutes + ' minutes; the link expires in ' + tokenMinutes + ' minutes.',
    '',
    SECURITY_NOTE,
    '',
    'If you did not create a SyncSpace account, you can safely ignore this email.',
  ].join('\n')

  const html = frame({
    heading: 'Welcome to SyncSpace',
    body: `
      <p style="margin:0 0 16px">Verify your email address to activate your account.</p>
      <p style="margin:0 0 8px;color:#7d746d;font-size:13px">Or enter this code:</p>
      ${codeBlock(code)}
      <p style="margin:0;color:#7d746d;font-size:13px">
        The code expires in ${codeMinutes} minutes. The link expires in ${tokenMinutes} minutes.
      </p>`,
    action: { url, label: 'Verify email' },
    footnote: `${escapeHtml(SECURITY_NOTE)}<br><br>
      If you did not create a SyncSpace account, you can safely ignore this email.`,
  })

  return { subject, text, html }
}

/**
 * A room invitation.
 *
 * Carries both ways in, deliberately. The link is one click; the room code
 * underneath it is what gets typed into the dashboard by somebody who would
 * rather not follow a link in an email, and what gets read out loud over a
 * call. Dropping the code to make room for a token would take a working way
 * in away from people.
 *
 * `signUpUrl` is present when the address has no account yet: the invitation
 * has to survive them registering and verifying, so the mail offers the way in
 * rather than a link that would refuse them.
 */
export function invitationEmail({ inviter, room, code, url, signUpUrl, hours }) {
  const who = inviter || 'Someone'
  const where = room || code

  const subject = who + ' invited you to ' + where + ' on SyncSpace'
  const opening = who + ' invited you to collaborate on "' + where + '" in SyncSpace.'

  const text = [
    opening,
    '',
    signUpUrl ? 'Create an account with this address and the room is waiting for you:' : 'Open the room:',
    signUpUrl || url,
    '',
    signUpUrl ? 'The room itself:\n' + url + '\n' : '',
    'Or go to your dashboard and join with this room code: ' + code,
    '',
    'This invitation is tied to this address, expires in ' + hours + ' hours, and can be used once.',
    '',
    'If you were not expecting this, you can ignore this email — nothing happens until you open the link.',
  ]
    .filter((line) => line !== '')
    .join('\n')

  const html = frame({
    heading: escapeHtml(who) + ' invited you to collaborate',
    body: `
      <p style="margin:0 0 16px">
        You have been invited to the SyncSpace room
        <strong style="color:#f2ece7">${escapeHtml(where)}</strong>.
      </p>
      ${
        signUpUrl
          ? `<p style="margin:0 0 16px;color:#7d746d;font-size:13px">
               You will need a SyncSpace account with this address first —
               <a href="${escapeHtml(signUpUrl)}" style="color:#e8a33d">create one here</a>.
             </p>`
          : ''
      }
      <p style="margin:0 0 8px;color:#7d746d;font-size:13px">
        Or join from your dashboard with this room code:
      </p>
      <p style="margin:0 0 16px"><strong>${escapeHtml(code)}</strong></p>
      <p style="margin:0;color:#7d746d;font-size:13px">
        This invitation expires in ${hours} hours and can be used once.
      </p>`,
    action: { url, label: 'Join room' },
    footnote: `If you were not expecting this, you can ignore this email — nothing happens
      until you open the link.`,
  })

  return { subject, text, html }
}

/** Password recovery. Shorter-lived than a confirmation, and says why. */
export function passwordResetEmail({ url, minutes }) {
  const subject = 'Reset your SyncSpace password'

  const text = [
    'Somebody asked to reset the password on your SyncSpace account.',
    '',
    'Choose a new one here:',
    url,
    '',
    'This link expires in ' + minutes + ' minutes and can be used once.',
    '',
    'If it was not you, ignore this email — your password has not changed, and',
    'resetting it is the only thing this link can do.',
  ].join('\n')

  const html = frame({
    heading: 'Reset your password',
    body: `
      <p style="margin:0 0 16px">
        Somebody asked to reset the password on your SyncSpace account.
      </p>
      <p style="margin:0;color:#7d746d;font-size:13px">
        This link expires in ${minutes} minutes and can be used once.
      </p>`,
    action: { url, label: 'Choose a new password' },
    footnote: `If it was not you, ignore this email — your password has not changed, and
      resetting it is the only thing this link can do.`,
  })

  return { subject, text, html }
}

/** Used by the mail-check script to prove a relay works end to end. */
export function relayCheckEmail() {
  return {
    subject: 'SyncSpace mail check',
    text: 'If you are reading this, the SyncSpace relay is configured correctly.',
    html: frame({
      heading: 'Mail is working',
      body: '<p style="margin:0">If you are reading this, the SyncSpace relay is configured correctly.</p>',
      footnote: 'Sent by <code>npm run mail:check</code>. Nothing about your account has changed.',
    }),
  }
}

/** The address every one of these is sent from, for anything reporting it. */
export const senderIdentity = () => env.MAIL_FROM ?? null
