import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionsDialog } from './SessionsDialog.jsx'
import { ToastProvider } from './ui/ToastProvider.jsx'
import { setAuthToken } from '../api/client.js'

/**
 * The device list.
 *
 * Two things here are not decoration. The current device has to be marked, or
 * the list is a row of indistinguishable browsers and the obvious way to find
 * out which one is yours is to sign one out and see. And it must not offer a
 * sign-out button for that row, because it is the likeliest misclick in the
 * dialog and it would log you out of the thing you are reading.
 */

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'

const now = new Date().toISOString()

const SESSIONS = [
  {
    id: 's1',
    userAgent: CHROME_WINDOWS,
    ip: '203.0.113.7',
    lastSeenAt: now,
    createdAt: now,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    current: true,
  },
  {
    id: 's2',
    userAgent: SAFARI_IPHONE,
    ip: '198.51.100.4',
    lastSeenAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 6 * 86400000).toISOString(),
    current: false,
  },
]

let calls

function mockApi({ list = SESSIONS, listStatus = 200, mutation } = {}) {
  calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    const method = init.method || 'GET'
    const path = String(url)
    calls.push({ method, path })

    if (method === 'GET') {
      return Promise.resolve({
        ok: listStatus < 400,
        status: listStatus,
        json: () =>
          Promise.resolve(
            listStatus < 400
              ? { sessions: list }
              : { error: { code: 'server_error', message: 'Could not load your devices' } }
          ),
      })
    }

    const answer = mutation ?? { ok: true, status: 200, body: { revoked: 1 } }
    return Promise.resolve({
      ok: answer.ok,
      status: answer.status,
      json: () => Promise.resolve(answer.body),
    })
  })
}

const renderDialog = (onClose = vi.fn()) =>
  render(
    <ToastProvider>
      <SessionsDialog open onClose={onClose} />
    </ToastProvider>
  )

const rows = () => screen.getAllByRole('listitem')

beforeEach(() => setAuthToken(null))
afterEach(() => vi.restoreAllMocks())

describe('SessionsDialog', () => {
  it('lists what is signed in, named readably', async () => {
    mockApi()
    renderDialog()

    expect(await screen.findByText('Chrome on Windows')).toBeInTheDocument()
    expect(screen.getByText('Safari on iPhone')).toBeInTheDocument()
    expect(rows()).toHaveLength(2)
  })

  it('asks the server when it opens', async () => {
    mockApi()
    renderDialog()

    await screen.findByText('Chrome on Windows')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'GET' })
    expect(calls[0].path).toContain('/auth/sessions')
  })

  it('shows where and when, so an unfamiliar row is recognisable as one', async () => {
    mockApi()
    renderDialog()

    await screen.findByText('Safari on iPhone')
    const phone = rows()[1]
    expect(within(phone).getByText(/198\.51\.100\.4/)).toBeInTheDocument()
    expect(within(phone).getByText(/signed in/i)).toBeInTheDocument()
  })

  /** Otherwise the only way to identify your own device is to sign one out. */
  it('marks the device it is being read on and offers it no sign-out button', async () => {
    mockApi()
    renderDialog()

    await screen.findByText('Chrome on Windows')

    const [current, other] = rows()
    expect(within(current).getByText('This device')).toBeInTheDocument()
    expect(within(current).queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
    expect(within(other).getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('signs out one device and drops it from the list', async () => {
    mockApi()
    const user = userEvent.setup()
    renderDialog()

    await screen.findByText('Safari on iPhone')
    await user.click(within(rows()[1]).getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(screen.queryByText('Safari on iPhone')).not.toBeInTheDocument())

    const revoke = calls.find((call) => call.method === 'DELETE')
    expect(revoke.path).toContain('/auth/sessions/s2')
    // The one being read on is untouched.
    expect(screen.getByText('Chrome on Windows')).toBeInTheDocument()
  })

  it('signs out everything else at once', async () => {
    mockApi({ mutation: { ok: true, status: 200, body: { revoked: 1 } } })
    const user = userEvent.setup()
    renderDialog()

    await screen.findByText('Safari on iPhone')
    await user.click(screen.getByRole('button', { name: 'Sign out all other devices' }))

    await waitFor(() => expect(screen.queryByText('Safari on iPhone')).not.toBeInTheDocument())

    const revoke = calls.find((call) => call.method === 'DELETE')
    expect(revoke.path).toMatch(/\/auth\/sessions$/)
    expect(screen.getByText('Chrome on Windows')).toBeInTheDocument()
    expect(await screen.findByText(/one other device signed out/i)).toBeInTheDocument()
  })

  it('has nothing to offer when this is the only device', async () => {
    mockApi({ list: [SESSIONS[0]] })
    renderDialog()

    await screen.findByText('Chrome on Windows')
    expect(screen.getByRole('button', { name: 'Sign out all other devices' })).toBeDisabled()
    expect(screen.getByText(/only device signed in/i)).toBeInTheDocument()
  })

  it('says so when the list cannot be loaded, and offers a retry', async () => {
    mockApi({ listStatus: 500 })
    const user = userEvent.setup()
    renderDialog()

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load your devices/i)

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2))
  })

  /**
   * If the server refused, the row is still signed in — leaving it struck off
   * the list would be a lie, so the list is re-read rather than guessed at.
   */
  it('re-reads the list when a sign-out is refused', async () => {
    mockApi({
      mutation: {
        ok: false,
        status: 404,
        body: { error: { code: 'session_not_found', message: 'That session is not signed in' } },
      },
    })
    const user = userEvent.setup()
    renderDialog()

    await screen.findByText('Safari on iPhone')
    await user.click(within(rows()[1]).getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByText(/that session is not signed in/i)).toBeInTheDocument()
    await waitFor(() => expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2))
  })
})
