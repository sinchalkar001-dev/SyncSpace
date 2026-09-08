import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AcceptInvitation from './AcceptInvitation.jsx'
import { AuthContext } from '../auth/AuthContext.js'

/**
 * The page somebody lands on from an invitation email.
 *
 * They arrive in one of four states, and each needs a different next step:
 * signed in and verified, signed in but unverified, not signed in at all, or
 * holding a link that no longer works. Getting that wrong means offering a
 * button that cannot work and a refusal nobody can act on.
 *
 * What is *not* here matters too. The server tells this page the room's name
 * and who invited them, and nothing about who else is in it — an invitation is
 * a key to one room, not a directory — so there is nothing here to leak.
 */

const INVITATION = {
  roomId: 'k7cZ5Yd6',
  roomName: 'Design review',
  role: 'editor',
  invitedBy: 'Priya',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
}

let responses

const authed = (over = {}) => ({
  isAuthenticated: true,
  isLoading: false,
  user: { id: 'u1', name: 'Sam', email: 'sam@example.test' },
  ...over,
})

const anonymous = { isAuthenticated: false, isLoading: false, user: null }

function renderPage(search, auth = authed()) {
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/accept-invitation' + search]}>
        <Routes>
          <Route path="/accept-invitation" element={<AcceptInvitation />} />
          <Route path="/room/:roomId" element={<p>In the room</p>} />
          <Route path="/register" element={<p>Register page</p>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  )
}

beforeEach(() => {
  responses = new Map()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      const path = String(url)
      const key = (options.method || 'GET') + ' ' + (path.includes('/accept') ? 'accept' : 'read')
      const answer = responses.get(key) ?? { status: 200, body: { invitation: INVITATION } }

      return {
        ok: answer.status < 400,
        status: answer.status,
        json: async () => answer.body,
      }
    })
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('AcceptInvitation', () => {
  it('says what the invitation is for before asking anything', async () => {
    renderPage('?token=' + 'a'.repeat(43))

    expect(await screen.findByText(/Priya invited you/)).toBeInTheDocument()
    expect(screen.getByText('Design review')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Join room' })).toBeInTheDocument()
  })

  it('joins the room when accepted', async () => {
    responses.set('POST accept', { status: 200, body: { room: { roomId: 'k7cZ5Yd6' }, role: 'editor' } })
    renderPage('?token=' + 'a'.repeat(43))

    await userEvent.click(await screen.findByRole('button', { name: 'Join room' }))

    expect(await screen.findByText('In the room')).toBeInTheDocument()
  })

  /**
   * The invitation is bound to an address, so signing up with the right one is
   * not a detail — it is the whole thing, and the copy has to say so.
   */
  it('sends a signed-out visitor to create an account, and says which address', async () => {
    renderPage('?token=' + 'a'.repeat(43), anonymous)

    expect(await screen.findByText(/Priya invited you/)).toBeInTheDocument()
    expect(screen.getByText(/address this invitation was sent to/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create an account' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Join room' })).not.toBeInTheDocument()
  })

  it('points an unverified account at verification rather than repeating the refusal', async () => {
    responses.set('POST accept', {
      status: 403,
      body: { error: { code: 'email_not_verified', message: 'Verify your email address first' } },
    })
    renderPage('?token=' + 'a'.repeat(43))

    await userEvent.click(await screen.findByRole('button', { name: 'Join room' }))

    expect(await screen.findByText('Verify your email first')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Verify my email' })).toBeInTheDocument()
  })

  it('explains a link that no longer works', async () => {
    responses.set('GET read', {
      status: 404,
      body: { error: { code: 'invitation_invalid', message: 'This invitation is invalid or has expired' } },
    })
    renderPage('?token=' + 'a'.repeat(43))

    expect(await screen.findByText('That invitation did not work')).toBeInTheDocument()
    // Expired, spent and sent-to-somebody-else all read the same here, because
    // the server deliberately does not distinguish them.
    expect(screen.getByText(/only work for the address they were sent to/)).toBeInTheDocument()
  })

  it('asks for the link when opened without one', async () => {
    renderPage('')

    expect(await screen.findByText('Nothing to accept')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })
})
