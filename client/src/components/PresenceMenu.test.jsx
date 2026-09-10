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
  pending: [],
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
   * A real relay takes seconds, so the server sometimes answers before the send
   * finishes. That is not a failure, and must not read as one: the code stays
   * out of the toast, because nobody has to pass it on by hand yet.
   */
  /**
   * The case the whole held-invite mechanism exists for. Saying "invited" and
   * nothing else would leave the owner watching a roster that never changes,
   * with no idea the person has to sign up first.
   */
  it('explains that a newcomer has to sign up before the room means anything', async () => {
    mockApi({
      invited: { id: null, name: null, email: 'stranger@syncspace.test', pending: true, notified: true },
    })
    renderMenu()
    const panel = await openPanel()

    const field = await within(panel).findByLabelText('Email address to invite')
    await userEvent.type(field, 'stranger@syncspace.test')
    await userEvent.click(within(panel).getByRole('button', { name: 'Invite' }))

    const said = await screen.findByText(/no account yet/)
    expect(said).toHaveTextContent('sign up with that address')
  })

  it('lists an invitation nobody has taken up, and can withdraw it', async () => {
    mockApi({
      roster: {
        ...ROSTER,
        pending: [{ email: 'stranger@syncspace.test', role: 'editor', at: new Date().toISOString() }],
      },
    })
    renderMenu()
    const panel = await openPanel()

    const row = (await within(panel).findByText('stranger@syncspace.test')).closest('li')
    expect(row).toHaveTextContent(/sign up/i)

    await userEvent.click(within(row).getByRole('button', { name: 'Withdraw' }))

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === 'DELETE' &&
            call.path.endsWith('/rooms/MSTTPQuJ/invites/stranger%40syncspace.test')
        )
      ).toBe(true)
    )
  })

  it('says the email is still sending when the server does not know yet', async () => {
    mockApi({ invited: { ...INVITED, notified: null } })
    renderMenu()
    const panel = await openPanel()

    const field = await within(panel).findByLabelText('Email address to invite')
    await userEvent.type(field, 'new@syncspace.test')
    await userEvent.click(within(panel).getByRole('button', { name: 'Invite' }))

    const said = await screen.findByText(/still sending/)
    expect(said).not.toHaveTextContent('MSTTPQuJ')
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

/**
 * Presence in the people panel: what everybody is doing, and the controls for
 * following them, finding them, and keeping your own activity to yourself.
 */
describe('what everybody in the room is doing', () => {
  const presenceApi = (over = {}) => ({
    following: null,
    followers: [],
    follow: vi.fn(() => true),
    unfollow: vi.fn(),
    focus: vi.fn(() => true),
    ...over,
  })

  const state = (over) => ({
    v: 1,
    activity: 'present',
    surface: null,
    file: null,
    line: null,
    selected: null,
    share: true,
    following: null,
    ...over,
  })

  const EDITING = state({ activity: 'editing', surface: 'code', file: 'Main.java', line: 42 })
  const DRAWING = state({ activity: 'drawing', surface: 'board' })
  const READING = state({ activity: 'reading', surface: 'code', file: 'main.py', line: 3 })
  const PRIVATE = state({ share: false })

  function renderLive({ peers, presence = presenceApi(), sharing = true, onSharingChange = vi.fn() }) {
    render(
      <ToastProvider>
        <PresenceMenu
          room={ROOM}
          roomId={ROOM.roomId}
          self={{ clientId: 1, user: OWNER, presence: READING }}
          peers={peers}
          user={{ id: 'u1' }}
          presence={presence}
          sharing={sharing}
          onSharingChange={onSharingChange}
        />
      </ToastProvider>
    )
    return { presence, onSharingChange }
  }

  const rowOf = (panel, name) => within(panel).getByText(name).closest('li')

  it('says what each person is doing, and where', async () => {
    renderLive({
      peers: [
        { clientId: 2, user: CANDIDATE, presence: EDITING },
        { clientId: 3, user: VISITOR, presence: DRAWING },
      ],
    })
    const panel = await openPanel()

    const candidate = rowOf(panel, 'Candidate')
    expect(within(candidate).getByText('Editing Main.java')).toBeInTheDocument()
    expect(within(candidate).getByText('Line 42')).toBeInTheDocument()

    const visitor = rowOf(panel, 'Guest-9f2a')
    expect(within(visitor).getByText('Drawing')).toBeInTheDocument()
    expect(within(visitor).getByText('Whiteboard')).toBeInTheDocument()

    // Your own row still says it is you.
    expect(within(rowOf(panel, 'Owner')).getByText('You')).toBeInTheDocument()
  })

  it('follows somebody, and gets out of the way so their view can be seen', async () => {
    const { presence } = renderLive({ peers: [{ clientId: 2, user: CANDIDATE, presence: EDITING }] })
    const panel = await openPanel()

    await userEvent.click(within(panel).getByRole('button', { name: 'Follow Candidate' }))

    expect(presence.follow).toHaveBeenCalledWith(2)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('offers to stop following the person already being followed', async () => {
    const presence = presenceApi({ following: 2 })
    renderLive({ peers: [{ clientId: 2, user: CANDIDATE, presence: EDITING }], presence })
    const panel = await openPanel()

    const stop = within(panel).getByRole('button', { name: 'Stop following Candidate' })
    expect(stop).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(stop)
    expect(presence.unfollow).toHaveBeenCalled()
  })

  it('goes to where somebody is without following them there', async () => {
    const { presence } = renderLive({ peers: [{ clientId: 2, user: CANDIDATE, presence: EDITING }] })
    const panel = await openPanel()

    await userEvent.click(within(panel).getByRole('button', { name: 'Go to Candidate' }))

    expect(presence.focus).toHaveBeenCalledWith(2)
    expect(presence.follow).not.toHaveBeenCalled()
  })

  /**
   * Disabled rather than hidden: a control missing from one row and present on
   * the next reads as a bug, and one visibly unavailable reads as their choice.
   */
  it('will neither follow nor find somebody who is not sharing, and says so', async () => {
    renderLive({ peers: [{ clientId: 2, user: CANDIDATE, presence: PRIVATE }] })
    const panel = await openPanel()

    const candidate = rowOf(panel, 'Candidate')
    expect(within(candidate).getByText('Online')).toBeInTheDocument()
    expect(within(candidate).getByText('Not sharing activity')).toBeInTheDocument()

    expect(within(panel).getByRole('button', { name: 'Follow Candidate' })).toBeDisabled()
    expect(within(panel).getByRole('button', { name: 'Go to Candidate' })).toBeDisabled()
  })

  it('lets you stop sharing your own activity', async () => {
    const { onSharingChange } = renderLive({ peers: [] })
    const panel = await openPanel()

    const toggle = within(panel).getByRole('button', { name: 'Share your activity' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(toggle)
    expect(onSharingChange).toHaveBeenCalledWith(false)
  })

  it('tells you who is following you', async () => {
    renderLive({
      peers: [{ clientId: 2, user: CANDIDATE, presence: state({ following: 1 }) }],
      presence: presenceApi({ followers: [{ clientId: 2, name: 'Candidate' }] }),
    })
    const panel = await openPanel()

    expect(within(rowOf(panel, 'Owner')).getByText('Candidate is following you')).toBeInTheDocument()
  })

  it('shows an invited member who is not connected as offline', async () => {
    renderLive({ peers: [{ clientId: 2, user: CANDIDATE, presence: EDITING }] })
    const panel = await openPanel()

    const reviewer = await within(panel).findByText('Reviewer')
    expect(within(reviewer.closest('li')).getByText('Offline')).toBeInTheDocument()
  })
})
