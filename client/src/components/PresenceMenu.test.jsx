import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PresenceMenu } from './PresenceMenu.jsx'
import { ToastProvider } from './ui/ToastProvider.jsx'
import { setAuthToken } from '../api/client.js'

const OWNER = { id: 'u1', name: 'Owner', color: '#f97316', guest: false }
const CANDIDATE = { id: 'u2', name: 'Candidate', color: '#22d3ee', guest: false }
const VISITOR = { id: 'local-9', name: 'Guest-9f2a', color: '#a78bfa', guest: true }

const ROOM = { roomId: 'MSTTPQuJ', name: 'Interview', isPublic: false, owner: 'u1', memberCount: 2 }

const ROSTER = {
  owner: { id: 'u1', name: 'Owner', email: 'owner@syncspace.test' },
  members: [
    { id: 'u1', name: 'Owner', email: 'owner@syncspace.test', role: 'owner' },
    { id: 'u2', name: 'Candidate', email: 'candidate@syncspace.test', role: 'editor' },
    { id: 'u3', name: 'Reviewer', email: 'reviewer@syncspace.test', role: 'editor' },
  ],
  blocked: [],
  participants: [],
}

/** What the invite endpoint answers with: who was let in, and whether they were told. */
const INVITED = { id: 'u9', name: 'Newcomer', email: 'new@syncspace.test', notified: true }

const ok = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) })

let calls

function mockApi({ roster = ROSTER, fails, invited = INVITED } = {}) {
  calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    const method = init.method || 'GET'
    const path = String(url)
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null })

    if (method !== 'GET' && fails) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () =>
          Promise.resolve({
            error: { code: 'user_not_found', message: 'Nobody is signed up with that email address' },
          }),
      })
    }

    if (path.endsWith('/people')) return Promise.resolve(ok(roster))
    if (path.endsWith('/invite')) return Promise.resolve(ok({ room: ROOM, invited }))
    return Promise.resolve(ok({ room: ROOM }))
  })
}

function renderMenu({ user = { id: 'u1' }, peers = [{ clientId: 2, user: CANDIDATE }] } = {}) {
  return render(
    <ToastProvider>
      <PresenceMenu
        room={ROOM}
        roomId={ROOM.roomId}
        self={{ clientId: 1, user: OWNER }}
        peers={peers}
        user={user}
      />
    </ToastProvider>
  )
}

const openPanel = async () => {
  await userEvent.click(screen.getByRole('button', { name: /People in this room/ }))
  return screen.getByRole('dialog', { name: 'People in this room' })
}

beforeEach(() => {
  setAuthToken('token-1')
  mockApi()
})

describe('PresenceMenu', () => {
  it('says how many people are in the room before it is opened', () => {
    renderMenu({ peers: [{ clientId: 2, user: CANDIDATE }, { clientId: 3, user: VISITOR }] })
    expect(screen.getByRole('button', { name: 'People in this room (3)' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('names everyone in the room, and marks who is who', async () => {
    renderMenu({ peers: [{ clientId: 2, user: CANDIDATE }, { clientId: 3, user: VISITOR }] })
    const panel = await openPanel()

    expect(within(panel).getByText('Owner')).toBeInTheDocument()
    expect(within(panel).getByText('Candidate')).toBeInTheDocument()
    expect(within(panel).getByText('Guest-9f2a')).toBeInTheDocument()
    expect(within(panel).getByText('You')).toBeInTheDocument()
    expect(within(panel).getByText('guest')).toBeInTheDocument()
  })

  it('lists invited members who are not connected separately', async () => {
    renderMenu()
    const panel = await openPanel()

    const away = await within(panel).findByText('Reviewer')
    expect(away).toBeInTheDocument()
    // The one who is here appears once, in the live list, not twice.
    expect(within(panel).getAllByText('Candidate')).toHaveLength(1)
  })

  it('removes someone who is in the room and re-reads the roster', async () => {
    renderMenu()
    const panel = await openPanel()
    await within(panel).findByText('Reviewer')

    const row = within(panel).getByText('Candidate').closest('li')
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === 'DELETE' && call.path.endsWith('/rooms/MSTTPQuJ/members/u2')
        )
      ).toBe(true)
    )

    // A removal changes membership, visits and the blocked list at once, so the
    // roster is read again rather than patched locally.
    const rosterReads = calls.filter((call) => call.path.endsWith('/people'))
    expect(rosterReads.length).toBeGreaterThan(1)
  })

  it('offers no way to remove yourself or a guest', async () => {
    renderMenu({ peers: [{ clientId: 3, user: VISITOR }] })
    await openPanel()

    // Both rows in the live list are unremovable: one is the owner looking at
    // their own name, the other joined by link and has no account to withdraw.
    const here = screen.getByRole('region', { name: 'In the room now' })
    expect(within(here).getAllByRole('listitem')).toHaveLength(2)
    expect(within(here).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })

  it('invites by email and clears the field', async () => {
    renderMenu()
    const panel = await openPanel()

    const field = await within(panel).findByLabelText('Email address to invite')
    await userEvent.type(field, 'new@syncspace.test')
    await userEvent.click(within(panel).getByRole('button', { name: 'Invite' }))

    await waitFor(() =>
      expect(calls.find((call) => call.method === 'POST')).toMatchObject({
        body: { email: 'new@syncspace.test' },
      })
    )
    await waitFor(() => expect(field).toHaveValue(''))
  })

  it('says the invitation is on its way, and to which address', async () => {
    renderMenu()
    const panel = await openPanel()

    const field = await within(panel).findByLabelText('Email address to invite')
    await userEvent.type(field, 'new@syncspace.test')
    await userEvent.click(within(panel).getByRole('button', { name: 'Invite' }))

    expect(
      await screen.findByText('Invited Newcomer — the room code is on its way to new@syncspace.test')
    ).toBeInTheDocument()
  })

  /**
   * With no relay configured the invite still works, but telling the guest has
   * just become the owner's job — so the code goes in the toast rather than
   * sending them off to find it.
   */
  it('hands the owner the room code when the email did not go out', async () => {
    mockApi({ invited: { ...INVITED, notified: false } })
    renderMenu()
    const panel = await openPanel()

    const field = await within(panel).findByLabelText('Email address to invite')
    await userEvent.type(field, 'new@syncspace.test')
    await userEvent.click(within(panel).getByRole('button', { name: 'Invite' }))

    const said = await screen.findByText(/the email did not go out/)
    expect(said).toHaveTextContent('MSTTPQuJ')
  })

  it('keeps a refused address in the field to be corrected', async () => {
    mockApi({ fails: true })
    renderMenu()
    const panel = await openPanel()

    const field = await within(panel).findByLabelText('Email address to invite')
    await userEvent.type(field, 'typo@syncspace.test')
    await userEvent.click(within(panel).getByRole('button', { name: 'Invite' }))

    expect(await screen.findByText(/Nobody is signed up with that email address/)).toBeInTheDocument()
    expect(field).toHaveValue('typo@syncspace.test')
  })

  it('shows the roster to a member but none of the owner controls', async () => {
    renderMenu({ user: { id: 'u2' } })
    const panel = await openPanel()

    expect(within(panel).getByText('Owner')).toBeInTheDocument()
    await within(panel).findByText('Reviewer')
    expect(within(panel).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(within(panel).queryByLabelText('Email address to invite')).not.toBeInTheDocument()
  })

  it('lets a removed person back in', async () => {
    mockApi({
      roster: {
        ...ROSTER,
        blocked: [{ id: 'u4', name: 'Dropped', email: 'dropped@syncspace.test', at: new Date().toISOString() }],
      },
    })
    renderMenu()
    const panel = await openPanel()

    await userEvent.click(await within(panel).findByRole('button', { name: 'Allow back' }))

    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === 'DELETE' && call.path.endsWith('/rooms/MSTTPQuJ/blocked/u4')
        )
      ).toBe(true)
    )
  })

  it('closes on Escape', async () => {
    renderMenu()
    await openPanel()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
