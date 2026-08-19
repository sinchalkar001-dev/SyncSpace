import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthContext } from './AuthContext.js'
import { readToken, writeToken } from './storage.js'
import { api, onAuthExpired, setAuthToken } from '../api/client.js'
import { identityFromUser, loadIdentity, renameIdentity } from '../lib/identity.js'

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

    api
      .me(controller.signal)
      .then((payload) => {
        setUser(payload.user)
        setToken(stored)
        setStatus('authenticated')
      })
      .catch((error) => {
        if (error?.name === 'AbortError') return
        writeToken(null)
        setAuthToken(null)
        setStatus('guest')
      })

    return () => controller.abort()
  }, [])

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
      login,
      register,
      logout,
      renameGuest,
    }),
    [status, user, token, identity, login, register, logout, renameGuest]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
