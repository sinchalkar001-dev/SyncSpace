import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChangePasswordDialog } from './ChangePasswordDialog.jsx'
import { ToastProvider } from './ui/ToastProvider.jsx'
import { AuthContext } from '../auth/AuthContext.js'
import { setAuthToken } from '../api/client.js'

/**
 * Changing the password from the account menu.
 *
 * The server now ends every session opened under the old password, which
 * includes the one this dialog is being used from. It answers a replacement,
 * and adopting it is what keeps this tab signed in — a dialog that ignored the
 * new token would succeed and then sign the user out one request later.
 */

const SESSION = {
  user: { id: 'u1', name: 'Ada', email: 'ada@syncspace.test', emailVerified: true },
  token: 'a.new.jwt',
}

const CURRENT = 'correct-horse-battery'
const NEXT = 'an-entirely-new-passphrase'

let calls

function mockApi({ status = 200, body = SESSION } = {}) {
  calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    calls.push({
      method: init.method || 'GET',
      path: String(url),
      body: init.body ? JSON.parse(init.body) : null,
    })
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })
  })
}

const adopt = vi.fn((payload) => payload.user)
const onClose = vi.fn()

const renderDialog = () =>
  render(
    <AuthContext.Provider value={{ status: 'authenticated', isAuthenticated: true, adopt }}>
      <ToastProvider>
        <ChangePasswordDialog open onClose={onClose} />
      </ToastProvider>
    </AuthContext.Provider>
  )

const fillAndSubmit = async (user, { current = CURRENT, next = NEXT, confirm = NEXT } = {}) => {
  await user.type(screen.getByLabelText('Current password'), current)
  await user.type(screen.getByLabelText('New password'), next)
  await user.type(screen.getByLabelText('Confirm new password'), confirm)
  await user.click(screen.getByRole('button', { name: 'Update password' }))
}

beforeEach(() => {
  setAuthToken(null)
  adopt.mockClear()
  onClose.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('ChangePasswordDialog', () => {
  it('sends the current and new password', async () => {
    mockApi()
    const user = userEvent.setup()
    renderDialog()

    await fillAndSubmit(user)

    expect(calls).toHaveLength(1)
    expect(calls[0].path).toContain('/auth/change-password')
    expect(calls[0].body).toEqual({ currentPassword: CURRENT, newPassword: NEXT })
  })

  /**
   * The one that matters now. The token this tab was using is among the
   * sessions the change just ended, so ignoring the replacement would sign the
   * user out of the window they changed it in.
   */
  it('adopts the replacement session so this tab stays signed in', async () => {
    mockApi()
    const user = userEvent.setup()
    renderDialog()

    await fillAndSubmit(user)

    expect(adopt).toHaveBeenCalledWith(SESSION)
    expect(onClose).toHaveBeenCalled()
  })

  it('says that the other devices were signed out', async () => {
    mockApi()
    const user = userEvent.setup()
    renderDialog()

    await fillAndSubmit(user)

    expect(await screen.findByText(/other devices signed out/i)).toBeInTheDocument()
  })

  it('tells the user up front what changing it will do', () => {
    mockApi()
    renderDialog()

    expect(screen.getByText(/every other device is signed out/i)).toBeInTheDocument()
  })

  it('keeps the session when the server refuses the current password', async () => {
    mockApi({
      status: 401,
      body: { error: { code: 'bad_password', message: 'Current password is incorrect' } },
    })
    const user = userEvent.setup()
    renderDialog()

    await fillAndSubmit(user, { current: 'the-wrong-one' })

    expect(await screen.findByRole('alert')).toHaveTextContent(/current password is incorrect/i)
    expect(adopt).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not send a mismatched confirmation', async () => {
    mockApi()
    const user = userEvent.setup()
    renderDialog()

    await fillAndSubmit(user, { confirm: 'something-else-entirely' })

    expect(await screen.findByText('These do not match.')).toBeInTheDocument()
    expect(calls).toHaveLength(0)
    expect(adopt).not.toHaveBeenCalled()
  })
})
