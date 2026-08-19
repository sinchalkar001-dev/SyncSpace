import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthProvider } from './AuthProvider.jsx'
import { useAuth } from './useAuth.js'
import { setAuthToken } from '../api/client.js'

const USER = { id: 'u1', email: 'alice@syncspace.test', name: 'Alice' }

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }
}

function Probe() {
  const { status, identity, isAuthenticated, login, logout } = useAuth()
  return (
    <div>
      <span data-testid="status">{status}</span>
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
