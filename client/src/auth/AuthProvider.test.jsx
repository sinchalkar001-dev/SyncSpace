import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthProvider, WAKE_DEADLINE_MS, WAKING_AFTER_MS } from './AuthProvider.jsx'
import { useAuth } from './useAuth.js'
import { setAuthToken } from '../api/client.js'

const USER = { id: 'u1', email: 'alice@syncspace.test', name: 'Alice' }

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }
}

function Probe() {
  const { status, identity, isAuthenticated, waking, login, logout } = useAuth()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="waking">{String(waking)}</span>
      <span data-testid="name">{identity.name}</span>
      <span data-testid="guest">{String(!isAuthenticated)}</span>
      <button onClick={() => login({ email: USER.email, password: 'passphrase' })}>sign in</button>
      <button onClick={logout}>sign out</button>
    </div>
  )
}

const renderProbe = () =>
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  )

beforeEach(() => {
  setAuthToken(null)
  localStorage.clear()
})

describe('AuthProvider', () => {
  it('settles into guest mode when there is no stored token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    renderProbe()

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('guest'))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('name').textContent).toMatch(/^Guest-/)
  })

  it('restores a session from a stored token', async () => {
    localStorage.setItem('syncspace:token', 'stored-token')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: USER }))

    renderProbe()

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    expect(screen.getByTestId('name')).toHaveTextContent('Alice')
    expect(screen.getByTestId('guest')).toHaveTextContent('false')
  })

  it('discards a token the server rejects', async () => {
    localStorage.setItem('syncspace:token', 'expired-token')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { code: 'unauthorized', message: 'expired' } }, 401)
    )

    renderProbe()

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('guest'))
    expect(localStorage.getItem('syncspace:token')).toBeNull()
  })

  describe('while the server is asleep', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      return () => vi.useRealTimers()
    })

    const settle = (ms) => act(() => vi.advanceTimersByTimeAsync(ms))

    it('keeps the stored token when the server never answers', async () => {
      localStorage.setItem('syncspace:token', 'stored-token')
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

      renderProbe()
      await settle(WAKE_DEADLINE_MS + 10_000)

      expect(screen.getByTestId('status')).toHaveTextContent('guest')
      expect(localStorage.getItem('syncspace:token')).toBe('stored-token')
    })

    it('says it is waiting, then restores the session once the server wakes', async () => {
      localStorage.setItem('syncspace:token', 'stored-token')
      let awake = false
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        awake
          ? Promise.resolve(jsonResponse({ user: USER }))
          : Promise.resolve({
              ok: false,
              status: 502,
              json: () => Promise.reject(new SyntaxError()),
            })
      )

      renderProbe()
      await settle(WAKING_AFTER_MS + 100)
      expect(screen.getByTestId('status')).toHaveTextContent('loading')
      expect(screen.getByTestId('waking')).toHaveTextContent('true')

      awake = true
      await settle(10_000)

      expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
      expect(screen.getByTestId('waking')).toHaveTextContent('false')
    })
  })

  it('stores the token and identity after signing in', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ user: USER, token: 'fresh-token' })
    )
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('guest'))

    await userEvent.click(screen.getByRole('button', { name: 'sign in' }))

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    expect(localStorage.getItem('syncspace:token')).toBe('fresh-token')
    expect(screen.getByTestId('name')).toHaveTextContent('Alice')
  })

  it('clears the session and falls back to a guest identity on sign out', async () => {
    localStorage.setItem('syncspace:token', 'stored-token')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: USER }))
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))

    await userEvent.click(screen.getByRole('button', { name: 'sign out' }))

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('guest'))
    expect(localStorage.getItem('syncspace:token')).toBeNull()
    expect(screen.getByTestId('name').textContent).toMatch(/^Guest-/)
  })
})
