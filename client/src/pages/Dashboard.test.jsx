import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Dashboard from './Dashboard.jsx'
import { AuthProvider } from '../auth/AuthProvider.jsx'
import { ToastProvider } from '../components/ui/ToastProvider.jsx'
import { setAuthToken } from '../api/client.js'

const USER = { id: 'u1', email: 'owner@syncspace.test', name: 'Owner' }

const DAY = 24 * 60 * 60 * 1000

/**
 * Deliberately older than the week `continueRoom` considers worth resuming.
 *
 * These tests are about managing a room, and a fresh timestamp would also put
 * this room in the Continue strip - where its name appears a second time and
 * every `getByText` below becomes ambiguous. The Continue behaviour has its
 * own tests further down, with a room recent enough to earn it.
 */
const ROOM = {
  roomId: 'FmXAf3dE',
  name: 'Bakchodi',
  description: '',
  kind: 'general',
  owner: 'u1',
  isPublic: false,
  memberCount: 1,
  collaborators: [],
  pinned: false,
  archived: false,
  lastActivityAt: new Date(Date.now() - 10 * DAY).toISOString(),
  updatedAt: new Date(Date.now() - 10 * DAY).toISOString(),
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
let patchCalls
let prefCalls

function mockApi(overrides = {}) {
  deleteCalls = []
  patchCalls = []
  prefCalls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    const method = init.method || 'GET'
    const path = String(url)

    if (path.endsWith('/auth/me')) return Promise.resolve(ok({ user: USER }))
    if (path.endsWith('/rooms') && method === 'GET') {
      return Promise.resolve(ok({ rooms: overrides.rooms || [overrides.room || ROOM] }))
    }
    if (path.includes('/activity')) {
      return Promise.resolve(ok({ activity: overrides.activity || [] }))
    }
    if (path.endsWith('/people')) return Promise.resolve(ok(PEOPLE))
    if (method === 'PUT' && path.includes('/preferences')) {
      const body = JSON.parse(init.body)
      prefCalls.push(body)
      if (overrides.preferenceFails) {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () =>
            Promise.resolve({ error: { code: 'room_forbidden', message: 'No access' } }),
        })
      }
      return Promise.resolve(ok({ preference: { roomId: 'FmXAf3dE', ...body } }))
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(init.body)
      patchCalls.push(patch)
      if (overrides.patchFails) {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: { code: 'not_owner', message: 'Not the owner' } }),
        })
      }
      return Promise.resolve(ok({ room: { ...(overrides.room || ROOM), ...patch } }))
    }
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
    // The role tag specifically, not any text reading "Owner": roles now
    // render as labels rather than the raw stored value, and this fixture's
    // member happens to be named Owner too, so a plain text match finds both.
    expect(dialog.querySelector('.people__tag')?.textContent).toBe('Owner')
  })

  it('offers rename and a visibility switch in the menu', async () => {
    mockApi()
    renderDashboard()
    await screen.findByText('Bakchodi')

    await openMenu()
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    // The room is private, so the menu offers the opposite action.
    expect(screen.getByRole('menuitem', { name: 'Make public' })).toBeInTheDocument()
  })

  it('flips visibility and updates the pill', async () => {
    mockApi()
    renderDashboard()
    await screen.findByText('Bakchodi')
    expect(screen.getByText('Private')).toBeInTheDocument()

    await openMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Make public' }))

    await waitFor(() => expect(screen.getByText('Public')).toBeInTheDocument())
    expect(patchCalls).toEqual([{ isPublic: true }])
  })

  it('restores the previous visibility if the server refuses', async () => {
    mockApi({ patchFails: true })
    renderDashboard()
    await screen.findByText('Bakchodi')

    await openMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Make public' }))

    expect(await screen.findByText('Not the owner')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Private')).toBeInTheDocument())
  })

  it('renames a room from the menu', async () => {
    mockApi()
    renderDashboard()
    await screen.findByText('Bakchodi')

    await openMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))

    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText('Room name')
    await userEvent.clear(input)
    await userEvent.type(input, 'Candidate screen')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.getByText('Candidate screen')).toBeInTheDocument())
    expect(patchCalls).toEqual([{ name: 'Candidate screen' }])
  })

  it('leads an unnamed room with its code so two are never identical', async () => {
    const unnamed = { ...ROOM, name: 'Untitled room' }
    mockApi({ room: unnamed })
    renderDashboard()

    expect(await screen.findByText('FmXAf3dE')).toBeInTheDocument()
    expect(screen.getByText('Unnamed')).toBeInTheDocument()
    expect(screen.queryByText('Untitled room')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Manage FmXAf3dE/ }))
    expect(screen.getByRole('menuitem', { name: 'Name this room' })).toBeInTheDocument()
  })
})

/**
 * The workspace half of the dashboard.
 *
 * These cover the things a room list has to do once there are more rooms than
 * fit on a screen: get you back into the one you were in, keep the ones you
 * chose at the top, put the finished ones away, and let you find the rest by
 * anything you might remember about them.
 */
describe('dashboard as a workspace', () => {
  const RECENT = {
    ...ROOM,
    roomId: 'RecentAA',
    name: 'Candidate screen',
    description: 'Two-sum, then scale it',
    kind: 'interview',
    collaborators: [
      { id: 'u1', name: 'Owner', role: 'owner' },
      { id: 'u2', name: 'Ayush', role: 'editor' },
    ],
    memberCount: 5,
    lastActivityAt: new Date().toISOString(),
  }

  it('offers the most recently active room to resume, and opens it', async () => {
    mockApi({ rooms: [RECENT, ROOM] })
    renderDashboard()

    const strip = await screen.findByRole('region', { name: /Continue where you left off/i })
    expect(within(strip).getByRole('heading', { name: 'Candidate screen' })).toBeInTheDocument()
    expect(within(strip).getByText('Two-sum, then scale it')).toBeInTheDocument()
    expect(within(strip).getByRole('button', { name: 'Resume' })).toBeInTheDocument()
  })

  /**
   * A prominent "resume" pointing at a fortnight-old room is not resuming
   * anything, and an empty dashboard should say so rather than dress up an old
   * room as a session in progress.
   */
  it('offers nothing to resume when every room has gone quiet', async () => {
    mockApi()
    renderDashboard()
    await screen.findByText('Bakchodi')

    expect(
      screen.queryByRole('region', { name: /Continue where you left off/i })
    ).not.toBeInTheDocument()
  })

  it('shows what a room is, who is in it, and when it changed', async () => {
    mockApi({ rooms: [RECENT] })
    renderDashboard()

    const list = await screen.findByRole('list', { name: 'Your rooms' })
    const card = within(list).getByRole('listitem')

    expect(within(card).getByText('Interview')).toBeInTheDocument()
    expect(within(card).getByText('Two-sum, then scale it')).toBeInTheDocument()
    expect(within(card).getByText('Private')).toBeInTheDocument()
    // Two faces are shown and the remaining three are counted, not drawn.
    expect(within(card).getByRole('img', { name: /Owner, Ayush and 3 more/ })).toBeInTheDocument()
  })

  it('pins a room, lifts it into its own group, and says so to the server', async () => {
    mockApi({ rooms: [RECENT, ROOM] })
    renderDashboard()
    await screen.findByText('Bakchodi')

    await userEvent.click(screen.getByRole('button', { name: 'Pin Bakchodi' }))

    await waitFor(() => expect(prefCalls).toEqual([{ pinned: true }]))
    const pinnedList = await screen.findByRole('list', { name: 'Pinned' })
    expect(within(pinnedList).getByText('Bakchodi')).toBeInTheDocument()
  })

  it('puts the pin back if the server refuses it', async () => {
    mockApi({ preferenceFails: true })
    renderDashboard()
    await screen.findByText('Bakchodi')

    await userEvent.click(screen.getByRole('button', { name: 'Pin Bakchodi' }))

    expect(await screen.findByText('No access')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Pin Bakchodi' })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    )
  })

  it('archives a room out of the way, and can show it again', async () => {
    mockApi()
    renderDashboard()
    await screen.findByText('Bakchodi')

    await openMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))

    await waitFor(() => expect(prefCalls).toEqual([{ archived: true }]))
    await waitFor(() => expect(screen.queryByText('Bakchodi')).not.toBeInTheDocument())

    // Archived is kept, not deleted, and the toggle is the way back to it.
    await userEvent.click(screen.getByRole('button', { name: /Archived/ }))
    expect(await screen.findByText('Bakchodi')).toBeInTheDocument()
  })

  it('filters by what a room is for', async () => {
    mockApi({ rooms: [RECENT, ROOM] })
    renderDashboard()
    await screen.findByText('Bakchodi')

    await userEvent.click(screen.getByRole('tab', { name: /Interview/ }))

    // Scoped to the grid: the resumed room is legitimately named twice on this
    // page, once in the Continue strip and once as a card, and only the card
    // is what the filter governs.
    const list = screen.getByRole('list', { name: 'Your rooms' })
    expect(within(list).getByText('Candidate screen')).toBeInTheDocument()
    expect(within(list).queryByText('Bakchodi')).not.toBeInTheDocument()
  })

  /**
   * Searching only names would miss the two things people actually remember
   * about a room they cannot name: what it was for, and who was in it.
   */
  it('searches descriptions and the people in a room, not just names', async () => {
    mockApi({ rooms: [RECENT, ROOM] })
    renderDashboard()
    await screen.findByText('Bakchodi')

    const search = screen.getByLabelText('Search rooms')
    const list = () => screen.getByRole('list', { name: 'Your rooms' })

    await userEvent.type(search, 'two-sum')
    await waitFor(() => expect(screen.queryByText('Bakchodi')).not.toBeInTheDocument())
    expect(within(list()).getByText('Candidate screen')).toBeInTheDocument()

    await userEvent.clear(search)
    await userEvent.type(search, 'ayush')
    await waitFor(() => expect(screen.queryByText('Bakchodi')).not.toBeInTheDocument())
    expect(within(list()).getByText('Candidate screen')).toBeInTheDocument()
  })

  it('says what happened, in which room, and links back to it', async () => {
    mockApi({
      activity: [
        {
          id: 'a1',
          roomId: 'FmXAf3dE',
          kind: 'execution.completed',
          actorName: 'Ayush',
          detail: 'python ran cleanly',
          at: new Date().toISOString(),
        },
        {
          id: 'a2',
          roomId: 'FmXAf3dE',
          kind: 'collaborator.joined',
          actorName: null,
          detail: 'joined by link',
          at: new Date().toISOString(),
        },
      ],
    })
    renderDashboard()

    const feed = await screen.findByRole('region', { name: 'Recent activity' })
    expect(within(feed).getByText('Ayush ran the code')).toBeInTheDocument()
    expect(within(feed).getByText('python ran cleanly')).toBeInTheDocument()

    // A guest has no account and often no name; the line must still read.
    expect(within(feed).getByText('Somebody joined the room')).toBeInTheDocument()
    expect(within(feed).getAllByText(/Bakchodi/)[0]).toBeInTheDocument()
  })

  /**
   * The feed is a panel beside the rooms, not the page. It failing must not
   * read as the dashboard being broken.
   */
  it('keeps the rooms when the activity feed fails', async () => {
    mockApi()
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
      const path = String(url)
      if (path.endsWith('/auth/me')) return Promise.resolve(ok({ user: USER }))
      if (path.includes('/activity')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: { code: 'oops', message: 'nope' } }),
        })
      }
      if (path.endsWith('/rooms') && (init.method || 'GET') === 'GET') {
        return Promise.resolve(ok({ rooms: [ROOM] }))
      }
      return Promise.resolve(ok({}))
    })

    renderDashboard()

    expect(await screen.findByText('Bakchodi')).toBeInTheDocument()
    expect(await screen.findByText(/Could not load recent activity/)).toBeInTheDocument()
  })

  it('jumps to search on / without stealing the key from a text field', async () => {
    mockApi()
    renderDashboard()
    await screen.findByText('Bakchodi')

    const search = screen.getByLabelText('Search rooms')

    await userEvent.keyboard('/')
    expect(search).toHaveFocus()

    // Already inside a field, so the slash is a character, not a shortcut.
    await userEvent.keyboard('/')
    expect(search).toHaveValue('/')
  })

  it('creates a room with the type chosen up front', async () => {
    const created = []
    mockApi()
    const previous = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
      const path = String(url)
      if (path.endsWith('/rooms') && init.method === 'POST') {
        created.push(JSON.parse(init.body))
        return Promise.resolve(ok({ room: { ...ROOM, roomId: 'NewRoom1' } }))
      }
      return previous(url, init)
    })

    renderDashboard()
    await screen.findByText('Bakchodi')

    await userEvent.click(screen.getByRole('button', { name: 'New room' }))
    const dialog = await screen.findByRole('dialog')

    await userEvent.type(within(dialog).getByLabelText('Room name'), 'Design review')
    await userEvent.selectOptions(within(dialog).getByLabelText('Room type'), 'system-design')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create room' }))

    await waitFor(() =>
      expect(created).toEqual([
        { name: 'Design review', description: undefined, kind: 'system-design' },
      ])
    )
  })
})
