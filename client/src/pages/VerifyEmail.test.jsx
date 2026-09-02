import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import VerifyEmail from './VerifyEmail.jsx'
import { VerifyEmailNotice } from '../components/VerifyEmailNotice.jsx'
import { ToastProvider } from '../components/ui/ToastProvider.jsx'
import { AuthContext } from '../auth/AuthContext.js'
import { setAuthToken } from '../api/client.js'

/**
 * Confirming an address, which until now had nowhere to land: the emails point
 * at /verify-email and the route did not exist, so every link ever sent went
 * to the 404 page.
 */

const TOKEN = 'a'.repeat(64)

let calls

function mockApi({ fails } = {}) {
  calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    calls.push({ method: init.method || 'GET', path: String(url), body: init.body ? JSON.parse(init.body) : null })

    if (fails) {
      return Promise.resolve({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: { code: 'invalid_token', message: 'This verification link is invalid or has expired' },
          }),
      })
    }

    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ user: { id: 'u1', email: 'a@b.test', emailVerified: true } }),
    })
  })
}

const session = (overrides = {}) => ({
  status: 'authenticated',
  isAuthenticated: true,
  isLoading: false,
  user: { id: 'u1', name: 'Ada', email: 'ada@syncspace.test', emailVerified: false },
  refresh: vi.fn(),
  ...overrides,
})

function renderPage(search, auth = session()) {
  return render(
    <AuthContext.Provider value={auth}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/verify-email' + search]}>
          <Routes>
            <Route path="/verify-email" element={<VerifyEmail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </AuthContext.Provider>
  )
}

beforeEach(() => {
  setAuthToken('token-1')
  mockApi()
})

describe('VerifyEmail', () => {
  it('spends the token on arrival and says the address is confirmed', async () => {
    renderPage('?token=' + TOKEN)

    expect(await screen.findByText('Email confirmed')).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      body: { token: TOKEN },
    })
  })

  /**
   * The token is single-use, so spending it twice would report a link that
   * worked perfectly as dead. React runs effects twice in development.
   */
  it('spends the token exactly once', async () => {
    renderPage('?token=' + TOKEN)
    await screen.findByText('Email confirmed')

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('tells the session the address is now verified', async () => {
    const auth = session()
    renderPage('?token=' + TOKEN, auth)

    await screen.findByText('Email confirmed')
    await waitFor(() => expect(auth.refresh).toHaveBeenCalled())
  })

  it('explains a link that has expired, and offers a fresh one', async () => {
    mockApi({ fails: true })
    renderPage('?token=' + TOKEN)

    expect(await screen.findByText('That link did not work')).toBeInTheDocument()
    expect(screen.getByText(/invalid or has expired/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Send a new link' }))
    await waitFor(() =>
      expect(calls.some((c) => c.path.endsWith('/auth/resend-verification'))).toBe(true)
    )
  })

  it('sends a signed-out visitor to sign in rather than offering a resend', async () => {
    mockApi({ fails: true })
    renderPage('?token=' + TOKEN, session({ isAuthenticated: false, user: null }))

    await screen.findByText('That link did not work')
    expect(screen.queryByRole('button', { name: 'Send a new link' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('asks for the emailed link when opened with no token', async () => {
    renderPage('')

    expect(await screen.findByText('Nothing to confirm')).toBeInTheDocument()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })
})

describe('VerifyEmailNotice', () => {
  const renderNotice = (auth) =>
    render(
      <AuthContext.Provider value={auth}>
        <ToastProvider>
          <VerifyEmailNotice />
        </ToastProvider>
      </AuthContext.Provider>
    )

  it('asks an unverified account to confirm, and can resend', async () => {
    renderNotice(session())

    expect(screen.getByText('ada@syncspace.test')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Resend' }))

    await waitFor(() =>
      expect(calls.some((c) => c.path.endsWith('/auth/resend-verification'))).toBe(true)
    )
    expect(await screen.findByText(/on its way/)).toBeInTheDocument()
  })

  it('stays out of the way once the address is verified', () => {
    renderNotice(
      session({ user: { id: 'u1', name: 'Ada', email: 'ada@syncspace.test', emailVerified: true } })
    )
    expect(screen.queryByText('ada@syncspace.test')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resend' })).not.toBeInTheDocument()
  })

  it('shows nothing to a guest, who has no address to confirm', () => {
    renderNotice(session({ isAuthenticated: false, user: null }))
    expect(screen.queryByRole('button', { name: 'Resend' })).not.toBeInTheDocument()
  })
})
