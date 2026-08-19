import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Dashboard from './Dashboard.jsx'
import { AuthProvider } from '../auth/AuthProvider.jsx'
import { ToastProvider } from '../components/ui/ToastProvider.jsx'
import { setAuthToken } from '../api/client.js'

const USER = { id: 'u1', email: 'owner@syncspace.test', name: 'Owner' }

const ROOM = {
  roomId: 'FmXAf3dE',
  name: 'Bakchodi',
  isPublic: false,
  memberCount: 1,
  lastActivityAt: new Date().toISOString(),
}

const PEOPLE = {
  owner: { id: 'u1', name: 'Owner', email: 'owner@syncspace.test' },
  members: [{ id: 'u1', name: 'Owner', email: 'owner@syncspace.test', role: 'owner' }],
  participants: [
    {
      id: 'p1',
      userId: null,
      name: 'Candidate',
      guest: true,
      visits: 3,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    },
  ],
}

const ok = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) })

let deleteCalls

function mockApi(overrides = {}) {
  deleteCalls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    const method = init.method || 'GET'
    const path = String(url)

    if (path.endsWith('/auth/me')) return Promise.resolve(ok({ user: USER }))
    if (path.endsWith('/rooms') && method === 'GET') {
      return Promise.resolve(ok({ rooms: [ROOM] }))
    }
    if (path.endsWith('/people')) return Promise.resolve(ok(PEOPLE))
    if (method === 'DELETE') {
      deleteCalls.push(path)
      if (overrides.deleteFails) {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: { code: 'not_owner', message: 'Not the owner' } }),
        })
      }
      return Promise.resolve(ok({ roomId: ROOM.roomId }))
    }
    return Promise.resolve(ok({}))
  })
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AuthProvider>
          <Dashboard />
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>
  )
}

const openMenu = async () => {
  const trigger = await screen.findByRole('button', { name: /Manage Bakchodi/ })
  await userEvent.click(trigger)
}

beforeEach(() => {
  setAuthToken(null)
  localStorage.clear()
  localStorage.setItem('syncspace:token', 'stored-token')
})

describe('dashboard room management', () => {
  it('lists a room with its code and privacy', async () => {
    mockApi()
    renderDashboard()

    expect(await screen.findByText('Bakchodi')).toBeInTheDocument()
    expect(screen.getByText('FmXAf3dE')).toBeInTheDocument()
    expect(screen.getByText('Private')).toBeInTheDocument()
  })

  it('keeps management behind a menu rather than on the card', async () => {
    mockApi()
    renderDashboard()
    await screen.findByText('Bakchodi')

    expect(screen.queryByRole('menuitem', { name: 'Delete room' })).not.toBeInTheDocument()

    await openMenu()
    expect(screen.getByRole('menuitem', { name: 'Delete room' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'People' })).toBeInTheDocument()
  })

  it('asks for confirmation before deleting, and does nothing on cancel', async () => {
    mockApi()
    renderDashboard()
    await screen.findByText('Bakchodi')

    await openMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete room' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(deleteCalls).toHaveLength(0)
    expect(screen.getByText('Bakchodi')).toBeInTheDocument()
  })

  it('deletes the room and removes it from the list', async () => {
    mockApi()
    renderDashboard()
    await screen.findByText('Bakchodi')

    await openMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete room' }))

    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete room' }))

    await waitFor(() => expect(screen.queryByText('Bakchodi')).not.toBeInTheDocument())
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0]).toContain('FmXAf3dE')
    expect(await screen.findByText(/Deleted Bakchodi/)).toBeInTheDocument()
  })

  it('puts the room back if the delete is refused', async () => {
    mockApi({ deleteFails: true })
    renderDashboard()
    await screen.findByText('Bakchodi')

    await openMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete room' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete room' }))

    expect(await screen.findByText('Not the owner')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Bakchodi')).toBeInTheDocument())
  })

  it('shows members and guests who opened the room', async () => {
    mockApi()
    renderDashboard()
    await screen.findByText('Bakchodi')

    await openMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'People' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Members')).toBeInTheDocument()
    expect(within(dialog).getByText('Opened this room')).toBeInTheDocument()

    expect(within(dialog).getByText('Candidate')).toBeInTheDocument()
    expect(within(dialog).getByText(/3 visits/)).toBeInTheDocument()
    expect(within(dialog).getByText('guest')).toBeInTheDocument()
    expect(within(dialog).getByText('owner')).toBeInTheDocument()
  })
})
