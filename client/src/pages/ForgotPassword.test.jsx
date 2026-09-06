import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import ForgotPassword from './ForgotPassword.jsx'
import Login from './Login.jsx'
import { ToastProvider } from '../components/ui/ToastProvider.jsx'
import { AuthContext } from '../auth/AuthContext.js'
import { setAuthToken } from '../api/client.js'

/**
 * Asking for a reset link.
 *
 * The security property this screen has to preserve is a negative one: it must
 * never tell a stranger whether an address is registered. The server answers
 * `{ sent: true }` either way, so the only way to leak it from here is for the
 * UI to invent a branch the server did not give it — which is exactly what the
 * "same confirmation either way" test below is watching for.
 */

let calls

function mockApi({ status = 200, body = { sent: true } } = {}) {
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

const session = (overrides = {}) => ({
  status: 'guest',
  isAuthenticated: false,
  isLoading: false,
  user: null,
  login: vi.fn(),
  ...overrides,
})

const renderPage = (ui = <ForgotPassword />, value = session()) =>
  render(
    <MemoryRouter>
      <AuthContext.Provider value={value}>
        {/* ForgotPassword itself raises no toasts, but Login does, and the
            last test renders Login to check the link into this flow. */}
        <ToastProvider>{ui}</ToastProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  )

beforeEach(() => setAuthToken(null))
afterEach(() => vi.restoreAllMocks())

describe('ForgotPassword', () => {
  it('asks the server for a link and confirms it', async () => {
    mockApi()
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Email'), 'ada@syncspace.test')
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    await screen.findByRole('heading', { name: 'Check your email' })

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].path).toContain('/auth/forgot-password')
    expect(calls[0].body).toEqual({ email: 'ada@syncspace.test' })
  })

  /**
   * The one that matters. An address with an account and one without produce
   * the same response from the server, so they must produce the same screen —
   * otherwise the page hands back the answer the API refused to give.
   */
  it('says exactly the same thing whether or not the address has an account', async () => {
    mockApi()
    const user = userEvent.setup()

    const known = renderPage()
    await user.type(screen.getByLabelText('Email'), 'ada@syncspace.test')
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }))
    await screen.findByRole('heading', { name: 'Check your email' })
    const first = known.container.textContent.replace('ada@syncspace.test', '<address>')
    known.unmount()

    const unknown = renderPage()
    await user.type(screen.getByLabelText('Email'), 'nobody@syncspace.test')
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }))
    await screen.findByRole('heading', { name: 'Check your email' })
    const second = unknown.container.textContent.replace('nobody@syncspace.test', '<address>')

    expect(second).toBe(first)
  })

  it('never claims the email was definitely sent', async () => {
    mockApi()
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Email'), 'ada@syncspace.test')
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    // "If that address has an account" — hedged, because the page does not know.
    expect(await screen.findByText(/if that address has an account/i)).toBeInTheDocument()
  })

  it('trims a pasted address before sending it', async () => {
    mockApi()
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Email'), '  ada@syncspace.test  ')
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    await screen.findByRole('heading', { name: 'Check your email' })
    expect(calls[0].body.email).toBe('ada@syncspace.test')
  })

  it('shows a real failure, such as being rate limited', async () => {
    mockApi({
      status: 429,
      body: {
        error: {
          code: 'rate_limited',
          message: 'Too many password reset emails requested, try again later',
        },
      },
    })
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Email'), 'ada@syncspace.test')
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/too many password reset emails/i)
    // And it stays on the form, so the address does not have to be retyped.
    expect(screen.getByLabelText('Email')).toHaveValue('ada@syncspace.test')
  })

  it('lets someone go back and use a different address', async () => {
    mockApi()
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('Email'), 'ada@syncspace.test')
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }))
    await screen.findByRole('heading', { name: 'Check your email' })

    await user.click(screen.getByRole('button', { name: 'Use a different address' }))

    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument()
  })

  it('does not ask the server anything until the form is submitted', () => {
    mockApi()
    renderPage()

    expect(calls).toHaveLength(0)
  })
})

describe('reaching it', () => {
  /**
   * The flow is worthless if nobody can find it, and the place people look is
   * the sign-in screen they were just refused by.
   */
  it('is linked from the sign-in page', () => {
    renderPage(<Login />)

    const link = screen.getByRole('link', { name: 'Reset it' })
    expect(link).toHaveAttribute('href', '/forgot-password')
  })
})
