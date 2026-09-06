import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ResetPassword from './ResetPassword.jsx'
import { ToastProvider } from '../components/ui/ToastProvider.jsx'
import { AuthContext } from '../auth/AuthContext.js'
import { setAuthToken } from '../api/client.js'

/**
 * Choosing a new password from an emailed link.
 *
 * Unlike the confirmation page, the token is not spent on arrival — it is
 * single-use and there is a form to fill in first, so spending it on a page
 * view would burn the link before the person typed anything. The first test
 * below is about exactly that.
 */

const TOKEN = 'a'.repeat(64)

const SESSION = {
  user: { id: 'u1', name: 'Ada', email: 'ada@syncspace.test', emailVerified: true },
  token: 'a.new.jwt',
}

let calls

function mockApi({ status = 200, body = SESSION } = {}) {
  calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    calls.push({
      method: init.method || 'GET',
      path: String(url),
      body: init.body ? JSON.parse(init.body) : null,
    })

    return Promise.resolve({
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
    })
  })
}

const adopt = vi.fn((payload) => payload.user)

const session = (overrides = {}) => ({
  status: 'guest',
  isAuthenticated: false,
  isLoading: false,
  user: null,
  adopt,
  ...overrides,
})

/**
 * Renders at a real URL so the token is read from the query string exactly as
 * it is when someone follows the link out of their inbox.
 */
const renderAt = (search, value = session()) =>
  render(
    <MemoryRouter initialEntries={['/reset-password' + search]}>
      <AuthContext.Provider value={value}>
        <ToastProvider>
          <Routes>
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/dashboard" element={<h1>My rooms</h1>} />
          </Routes>
        </ToastProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  )

const passwordBoxes = () => screen.getAllByLabelText(/password/i)

beforeEach(() => {
  setAuthToken(null)
  adopt.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('ResetPassword', () => {
  /**
   * The token is single-use, so a page that spent it on arrival would leave
   * the person looking at a form whose link was already dead.
   */
  it('does not spend the token just by opening the page', () => {
    mockApi()
    renderAt('?token=' + TOKEN)

    expect(calls).toHaveLength(0)
    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument()
  })

  it('sends the token from the link with the new password', async () => {
    mockApi()
    const user = userEvent.setup()
    renderAt('?token=' + TOKEN)

    const [password, confirm] = passwordBoxes()
    await user.type(password, 'an-entirely-new-passphrase')
    await user.type(confirm, 'an-entirely-new-passphrase')
    await user.click(screen.getByRole('button', { name: 'Save and sign in' }))

    await screen.findByRole('heading', { name: 'My rooms' })

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].path).toContain('/auth/reset-password')
    expect(calls[0].body).toEqual({ token: TOKEN, password: 'an-entirely-new-passphrase' })
  })

  /** The session the reset answers is the whole reason not to ask them to sign in. */
  it('signs in with the session it gets back', async () => {
    mockApi()
    const user = userEvent.setup()
    renderAt('?token=' + TOKEN)

    const [password, confirm] = passwordBoxes()
    await user.type(password, 'an-entirely-new-passphrase')
    await user.type(confirm, 'an-entirely-new-passphrase')
    await user.click(screen.getByRole('button', { name: 'Save and sign in' }))

    await screen.findByRole('heading', { name: 'My rooms' })
    expect(adopt).toHaveBeenCalledWith(SESSION)
  })

  it('refuses to submit a password shorter than the server would accept', async () => {
    mockApi()
    const user = userEvent.setup()
    renderAt('?token=' + TOKEN)

    const [password, confirm] = passwordBoxes()
    await user.type(password, 'short')
    await user.type(confirm, 'short')
    await user.click(screen.getByRole('button', { name: 'Save and sign in' }))

    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument()
    // Never sent, so a typo does not spend the single-use link.
    expect(calls).toHaveLength(0)
  })

  it('refuses to submit when the two boxes disagree', async () => {
    mockApi()
    const user = userEvent.setup()
    renderAt('?token=' + TOKEN)

    const [password, confirm] = passwordBoxes()
    await user.type(password, 'an-entirely-new-passphrase')
    await user.type(confirm, 'a-different-passphrase')
    await user.click(screen.getByRole('button', { name: 'Save and sign in' }))

    expect(await screen.findByText('These do not match.')).toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  /** Expired is the ordinary way to land here badly: the links last an hour. */
  it('offers a new link when the token has expired', async () => {
    mockApi({
      status: 400,
      body: {
        error: {
          code: 'invalid_token',
          message: 'This reset link is invalid or has expired',
        },
      },
    })
    const user = userEvent.setup()
    renderAt('?token=' + TOKEN)

    const [password, confirm] = passwordBoxes()
    await user.type(password, 'an-entirely-new-passphrase')
    await user.type(confirm, 'an-entirely-new-passphrase')
    await user.click(screen.getByRole('button', { name: 'Save and sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid or has expired/i)
    expect(screen.getByRole('link', { name: 'Ask for a new one' })).toHaveAttribute(
      'href',
      '/forgot-password'
    )
    expect(adopt).not.toHaveBeenCalled()
  })

  it('sends someone who arrives with no token somewhere useful', () => {
    mockApi()
    renderAt('')

    expect(screen.getByRole('heading', { name: 'Nothing to reset' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Send a new link' })).toHaveAttribute(
      'href',
      '/forgot-password'
    )
    // No form to submit, so nothing can be sent without a token.
    expect(screen.queryByRole('button', { name: 'Save and sign in' })).not.toBeInTheDocument()
  })

  it('reports a refusal without pretending the reset worked', async () => {
    mockApi({
      status: 429,
      body: {
        error: { code: 'rate_limited', message: 'Too many password reset attempts, try again later' },
      },
    })
    const user = userEvent.setup()
    renderAt('?token=' + TOKEN)

    const [password, confirm] = passwordBoxes()
    await user.type(password, 'an-entirely-new-passphrase')
    await user.type(confirm, 'an-entirely-new-passphrase')
    await user.click(screen.getByRole('button', { name: 'Save and sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/too many password reset attempts/i)
    expect(screen.queryByRole('heading', { name: 'My rooms' })).not.toBeInTheDocument()
    expect(adopt).not.toHaveBeenCalled()
  })
})
