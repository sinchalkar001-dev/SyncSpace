import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthContext } from './AuthContext.js'
import { readToken, writeToken } from './storage.js'
import { api, onAuthExpired, setAuthToken } from '../api/client.js'
import { identityFromUser, loadIdentity, renameIdentity } from '../lib/identity.js'

/** How long restoring a session may take before the page says why. */
export const WAKING_AFTER_MS = 3000

/**
 * How long a server that is not answering at all is waited for.
 *
 * A free host stops the API after a quiet spell and takes up to a minute to
 * start it again, answering nothing, or an error page, in the meantime.
 */
export const WAKE_DEADLINE_MS = 90 * 1000
const WAKE_POLL_MS = 3000

const unreachable = (error) => error?.code === 'network_error' || error?.code === 'server_unreachable'

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })

async function restoreSession(signal) {
  const deadline = Date.now() + WAKE_DEADLINE_MS
  for (;;) {
    try {
      return await api.me(signal)
    } catch (error) {
      if (!unreachable(error) || Date.now() >= deadline) throw error
      await pause(WAKE_POLL_MS, signal)
    }
  }
}

/**
 * Holds the session. Three states:
 *   loading       — restoring a stored token
 *   authenticated — a verified account
 *   guest         — no account; still allowed into public rooms
 *
 * Guest access is deliberate: the interview use case needs candidates to join
 * from a link without signing up. The server enforces the same rule.
 */
export function AuthProvider({ children }) {
  const [status, setStatus] = useState('loading')
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(null)
  const [guest, setGuest] = useState(loadIdentity)
  const [waking, setWaking] = useState(false)

  const logout = useCallback(() => {
    writeToken(null)
    setAuthToken(null)
    setToken(null)
    setUser(null)
    setStatus('guest')
  }, [])

  // A 401 on any authenticated request means the token is no longer good.
  useEffect(() => {
    onAuthExpired(logout)
    return () => onAuthExpired(null)
  }, [logout])

  useEffect(() => {
    const stored = readToken()
    if (!stored) {
      setStatus('guest')
      return undefined
    }

    const controller = new AbortController()
    setAuthToken(stored)
    const slow = setTimeout(() => setWaking(true), WAKING_AFTER_MS)

    restoreSession(controller.signal)
      .then((payload) => {
        setUser(payload.user)
        setToken(stored)
        setStatus('authenticated')
      })
      .catch((error) => {
        if (error?.name === 'AbortError') return
        setAuthToken(null)
        setStatus('guest')
        // Only an answer about the token is a reason to forget it. A server
        // that never answered said nothing about it, and dropping it there
        // signed people out every time the API was asleep.
        if (!unreachable(error)) writeToken(null)
      })
      .finally(() => {
        clearTimeout(slow)
        setWaking(false)
      })

    return () => {
      clearTimeout(slow)
      controller.abort()
    }
  }, [])

  /**
   * Takes a `{ user, token }` the server has already issued and makes it the
   * session. Exposed on the context as well as used by login and register,
   * because a password reset answers a session too: the token from the email
   * proved the address and the new password was just chosen, so asking the
   * person to sign in again would only be asking them to retype it.
   */
  const adopt = useCallback((payload) => {
    writeToken(payload.token)
    setAuthToken(payload.token)
    setToken(payload.token)
    setUser(payload.user)
    setStatus('authenticated')
    return payload.user
  }, [])

  const login = useCallback(
    async (credentials) => adopt(await api.login(credentials)),
    [adopt]
  )

  const register = useCallback(
    async (credentials) => adopt(await api.register(credentials)),
    [adopt]
  )

  /**
   * Re-reads the account. Confirming an email changes it server-side, and
   * without this the session goes on claiming the address is unverified until
   * the next reload.
   */
  const refresh = useCallback(async () => {
    if (!readToken()) return null
    const payload = await api.me().catch(() => null)
    if (payload?.user) setUser(payload.user)
    return payload?.user ?? null
  }, [])

  const renameGuest = useCallback((name) => setGuest(renameIdentity(name)), [])

  const identity = useMemo(() => (user ? identityFromUser(user) : guest), [user, guest])

  const value = useMemo(
    () => ({
      status,
      user,
      token,
      identity,
      isAuthenticated: status === 'authenticated',
      isLoading: status === 'loading',
      waking,
      login,
      register,
      logout,
      refresh,
      renameGuest,
      adopt,
    }),
    [status, user, token, identity, waking, login, register, logout, refresh, renameGuest, adopt]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
