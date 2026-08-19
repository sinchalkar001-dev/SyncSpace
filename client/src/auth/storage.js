const TOKEN_KEY = 'syncspace:token'

/**
 * The token lives in localStorage, which keeps sessions across reloads but is
 * readable by any script on the page. Moving to an httpOnly cookie is the
 * hardening step before this faces untrusted users; see the README.
 */
export function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function writeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Storage can be disabled; the session then lasts only for this tab.
  }
}
