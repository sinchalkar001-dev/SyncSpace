import { env } from '../../../../config/env.js'

/**
 * The one place the Vercel Sandbox SDK is loaded and handed its credentials.
 *
 * Loaded on first use rather than imported at the top: a deployment running
 * containers, or a laptop running bare processes, should not pay for an HTTP
 * client it will never call — and the test suite, which runs the process
 * backend, should not need the package to be importable at all.
 */

let loaded = null

export function loadSdk() {
  if (!loaded) {
    loaded = import('@vercel/sandbox').catch((error) => {
      // Not remembered: an install fixed while the server is up should work
      // on the next attempt rather than after a restart.
      loaded = null
      throw error
    })
  }
  return loaded
}

/**
 * What the SDK needs to act on somebody's behalf from outside Vercel.
 *
 * On Vercel itself the SDK would find an OIDC token on its own; this server
 * runs elsewhere, so it is an access token plus the two ids that say whose
 * sandboxes these are. All three or none — the SDK refuses a partial set, and
 * so does this, earlier and with the variable names in the message.
 */
export function credentials() {
  const token = env.VERCEL_TOKEN
  const teamId = env.VERCEL_TEAM_ID
  const projectId = env.VERCEL_PROJECT_ID

  if (!token || !teamId || !projectId) return null
  return { token, teamId, projectId }
}

/** The names of whichever of the three are missing, for the refusal. */
export function missingCredentials() {
  return [
    ['VERCEL_TOKEN', env.VERCEL_TOKEN],
    ['VERCEL_TEAM_ID', env.VERCEL_TEAM_ID],
    ['VERCEL_PROJECT_ID', env.VERCEL_PROJECT_ID],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
}

/** The HTTP status an SDK error carries, when it came from the API. */
export const statusOf = (error) => error?.response?.status ?? null

/** The API's own error code, when it sent one — `snapshot_not_found` and so on. */
export function codeOf(error) {
  const body = error?.json
  return body?.error?.code ?? body?.code ?? null
}

/**
 * An SDK failure in words a person can act on.
 *
 * The SDK's own messages are accurate and addressed to whoever wrote the
 * integration ("Status code 403 is not ok"). The person reading this one is
 * looking at a Run button that did not work, or at a deploy log, and the
 * useful thing to tell them is which of four or five things to go and fix.
 */
export function describeError(error) {
  const status = statusOf(error)
  const detail = String(error?.message || error || 'unknown error').slice(0, 300)

  if (status === 401) {
    return 'Vercel rejected VERCEL_TOKEN — it may have expired or been revoked (' + detail + ')'
  }
  if (status === 403) {
    return (
      'VERCEL_TOKEN has no access to that team or project — check VERCEL_TEAM_ID and ' +
      'VERCEL_PROJECT_ID, and the token\'s scope (' + detail + ')'
    )
  }
  if (status === 402) {
    return 'the Vercel account has used its sandbox allowance for now (' + detail + ')'
  }
  if (status === 429) {
    return 'Vercel is rate-limiting sandbox requests from this account; try again shortly (' + detail + ')'
  }

  return detail
}
