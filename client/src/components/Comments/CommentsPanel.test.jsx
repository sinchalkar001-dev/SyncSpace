import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommentsPanel } from './CommentsPanel.jsx'

/**
 * The comments panel and the badge that says there is something in it.
 *
 * Rendered against a stand-in for `useComments`, so what is under test is what
 * the panel shows and what it asks for — the hook has tests of its own.
 */

const ME = '65f0000000000000000000a1'
const BO = '65f0000000000000000000b2'
const CY = '65f0000000000000000000c3'

const PEOPLE = [
  { id: BO, name: 'Bo' },
  { id: CY, name: 'Cy' },
]

const message = (id, author, body, extra = {}) => ({
  id,
  author,
  authorName: author === ME ? 'Ada' : author === BO ? 'Bo' : 'Cy',
  body,
  mentions: [],
  createdAt: '2026-09-11T10:00:00.000Z',
  editedAt: null,
  deleted: false,
  ...extra,
})

const OPEN = {
  id: 't1',
  status: 'open',
  version: 1,
  anchor: { kind: 'code', line: 12, endLine: 12, snippet: 'return check(user)', start: 'AA==', end: 'AA==' },
  messages: [message('m1', BO, 'Should @Ada look at this?', { mentions: [ME] }), message('m2', ME, 'On it')],
}

const RESOLVED = {
  id: 't2',
  status: 'resolved',
  version: 3,
  anchor: { kind: 'shape', shapeId: 's1', label: 'Database' },
  messages: [message('m3', CY, 'Is this the primary?')],
}

function fakeComments(overrides = {}) {
  return {
    state: 'ready',
    error: null,
    threads: [OPEN, RESOLVED],
    people: PEOPLE,
    unread: { count: 0, mentions: 0 },
    markSeen: vi.fn(),
    reload: vi.fn(),
    create: vi.fn(async () => ({ id: 'new' })),
    reply: vi.fn(async () => true),
    setResolved: vi.fn(async () => true),
    edit: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    ...overrides,
  }
}

function renderPanel(props = {}) {
  const handlers = {
    onOpenChange: vi.fn(),
    onFocusThread: vi.fn(),
    onDraftDone: vi.fn(),
  }
  const comments = props.comments ?? fakeComments()

  render(
    <CommentsPanel
      comments={comments}
      open
      userId={ME}
      signedIn
      canWrite
      canModerate={false}
      draft={null}
      activeId={null}
      locate={() => null}
      {...handlers}
      {...props}
    />
  )
  return { comments, ...handlers }
}

const panel = () => screen.getByRole('dialog', { name: 'Comments' })
const threadOn = (label) => screen.getByRole('article', { name: 'Comment on ' + label })

describe('the comments button', () => {
  it('counts what is new, and turns into an @ when somebody mentions you', () => {
    renderPanel({ open: false, comments: fakeComments({ unread: { count: 3, mentions: 1 } }) })

    const button = screen.getByRole('button', { name: 'Comments (3 new, 1 mentioning you)' })
    expect(button).toHaveTextContent('@')
  })

  it('shows a plain count when nobody is mentioned', () => {
    renderPanel({ open: false, comments: fakeComments({ unread: { count: 12, mentions: 0 } }) })
    expect(screen.getByRole('button', { name: 'Comments (12 new)' })).toHaveTextContent('9+')
  })

  /** Opening the panel is reading it. */
  it('marks everything read once it is open', () => {
    const { comments } = renderPanel({ comments: fakeComments({ unread: { count: 2, mentions: 0 } }) })
    expect(comments.markSeen).toHaveBeenCalled()
  })

  it('does not ask the server anything when there is nothing new', () => {
    const { comments } = renderPanel()
    expect(comments.markSeen).not.toHaveBeenCalled()
  })
})

describe('the comments panel', () => {
  it('lists open threads first, and resolved ones behind their own filter', async () => {
    renderPanel()

    expect(threadOn('Line 12')).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: 'Comment on Database' })).not.toBeInTheDocument()

    await userEvent.click(within(panel()).getByRole('tab', { name: /Resolved/ }))
    expect(threadOn('Database')).toBeInTheDocument()
    expect(within(threadOn('Database')).getByText('Resolved', { selector: '.pill' })).toBeInTheDocument()
  })

  it('shows who said what, and highlights the people mentioned', () => {
    renderPanel({ userId: CY, comments: fakeComments({ people: [...PEOPLE, { id: ME, name: 'Ada' }] }) })

    const thread = threadOn('Line 12')
    expect(within(thread).getByText('Bo')).toBeInTheDocument()
    expect(within(thread).getByText('@Ada')).toHaveClass('thread__mention')
    expect(within(thread).getByText('return check(user)')).toBeInTheDocument()
  })

  /** The picker leaves you out; the highlighting must not. */
  it('highlights a mention of you', () => {
    const names = new Map([
      [BO, 'Bo'],
      [ME, 'Ada'],
    ])
    renderPanel({ comments: fakeComments({ names }) })

    expect(within(threadOn('Line 12')).getByText('@Ada')).toHaveClass('thread__mention')
  })

  /** A comment is about something, and the fastest way to understand it is to look. */
  it('takes you to what the comment is about', async () => {
    const { onFocusThread } = renderPanel()

    await userEvent.click(within(threadOn('Line 12')).getByRole('button', { name: 'Go to Line 12' }))
    expect(onFocusThread).toHaveBeenCalledWith(OPEN)
  })

  it('labels code by where it is now, not where it was written', () => {
    renderPanel({ locate: (thread) => (thread.id === 't1' ? { line: 30, endLine: 31, orphaned: false } : null) })
    expect(threadOn('Lines 30–31')).toBeInTheDocument()
  })

  it('says when the code a comment was about has been deleted', () => {
    renderPanel({ locate: () => ({ line: 12, endLine: 12, orphaned: true }) })
    expect(within(threadOn('Line 12')).getByText(/has been removed/)).toBeInTheDocument()
  })

  it('replies and resolves', async () => {
    const { comments } = renderPanel()
    const thread = threadOn('Line 12')

    await userEvent.type(within(thread).getByRole('combobox', { name: 'Reply to the comment on Line 12' }), 'Done')
    await userEvent.click(within(thread).getByRole('button', { name: 'Reply' }))
    expect(comments.reply).toHaveBeenCalledWith('t1', { text: 'Done', mentions: [] })

    await userEvent.click(within(thread).getByRole('button', { name: 'Resolve' }))
    expect(comments.setResolved).toHaveBeenCalledWith('t1', true)
  })

  it('lets authors edit and delete their own messages, and nobody else’s', async () => {
    const { comments } = renderPanel()
    const [theirs, mine] = within(threadOn('Line 12')).getAllByRole('listitem')

    expect(within(theirs).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(within(theirs).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()

    await userEvent.click(within(mine).getByRole('button', { name: 'Edit' }))
    const field = within(mine).getByRole('combobox', { name: 'Edit comment' })
    await userEvent.clear(field)
    await userEvent.type(field, 'On it now')
    await userEvent.click(within(mine).getByRole('button', { name: 'Save' }))
    expect(comments.edit).toHaveBeenCalledWith('t1', 'm2', { text: 'On it now', mentions: [] })
  })

  it('lets a moderator delete anybody’s message', async () => {
    const { comments } = renderPanel({ canModerate: true })
    const [theirs] = within(threadOn('Line 12')).getAllByRole('listitem')

    await userEvent.click(within(theirs).getByRole('button', { name: 'Delete' }))
    expect(comments.remove).toHaveBeenCalledWith('t1', 'm1')
  })

  it('shows a deleted message as deleted, rather than hiding that it was there', () => {
    renderPanel({
      comments: fakeComments({
        threads: [{ ...OPEN, messages: [message('m1', BO, '', { deleted: true }), message('m2', ME, 'On it')] }],
      }),
    })
    expect(within(threadOn('Line 12')).getByText('This comment was deleted.')).toBeInTheDocument()
  })

  it('lets somebody who may only read, read — and says why they cannot write', () => {
    renderPanel({ canWrite: false })

    const thread = threadOn('Line 12')
    expect(within(thread).queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument()
    expect(within(thread).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(panel()).getByText(/can read comments but not write them/)).toBeInTheDocument()
  })

  it('asks a guest to sign in', () => {
    renderPanel({ signedIn: false, canWrite: false, userId: undefined })
    expect(within(panel()).getByText('Sign in to comment.')).toBeInTheDocument()
  })

  it('says how to start when there are no comments yet', () => {
    renderPanel({ comments: fakeComments({ threads: [] }) })
    expect(within(panel()).getByText(/No comments yet/)).toBeInTheDocument()
  })

  it('reports a failure to load, and retries on request', async () => {
    const { comments } = renderPanel({ comments: fakeComments({ state: 'error', error: 'Could not reach the server' }) })

    expect(within(panel()).getByRole('alert')).toHaveTextContent('Could not reach the server')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Retry' }))
    expect(comments.reload).toHaveBeenCalled()
  })
})

describe('writing a new comment', () => {
  const DRAFT = { kind: 'shape', shapeId: 's9', offsetX: 0.5, offsetY: 0.5, x: 10, y: 10, label: 'Cache' }

  it('says what it is about, and posts it there with the people mentioned', async () => {
    const { comments, onDraftDone } = renderPanel({ draft: DRAFT })

    const draft = within(panel()).getByRole('region', { name: 'New comment' })
    expect(draft).toHaveTextContent('New comment on Cache')

    const field = within(draft).getByRole('combobox', { name: 'New comment' })
    await userEvent.type(field, 'ask @b')

    // Narrowed as the name is typed: Cy does not match, and the avatar's
    // initial is decoration, not part of anybody's name.
    const list = screen.getByRole('listbox', { name: 'People to mention' })
    expect(within(list).getAllByRole('option')).toHaveLength(1)
    expect(within(list).getByRole('option', { name: 'Bo' })).toBeInTheDocument()

    await userEvent.keyboard('{Enter}')
    expect(field).toHaveValue('ask @Bo ')

    await userEvent.type(field, 'about this')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')

    expect(onDraftDone).toHaveBeenCalled()
    expect(comments.create).toHaveBeenCalledWith({ anchor: DRAFT, text: 'ask @Bo about this', mentions: [BO] })
  })

  /**
   * Picking a person puts the caret after their name before the next keystroke
   * can land. It used to wait a frame, and words typed inside that frame were
   * split around the caret: "@Owner ou confirmcan y". Typed a few milliseconds
   * apart here, so the frame falls in the middle of the words.
   */
  it('keeps typing in order straight after a person is picked', async () => {
    const user = userEvent.setup({ delay: 5 })
    renderPanel({ draft: DRAFT })
    const field = within(panel()).getByRole('combobox', { name: 'New comment' })

    await user.type(field, 'ask @b')
    await user.keyboard('{Enter}')
    await user.keyboard('can you confirm')

    expect(field).toHaveValue('ask @Bo can you confirm')
  })

  it('moves through the people with the arrow keys', async () => {
    renderPanel({ draft: DRAFT })
    const field = within(panel()).getByRole('combobox', { name: 'New comment' })

    await userEvent.type(field, '@')
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: 'Cy' })).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{Tab}')
    expect(field).toHaveValue('@Cy ')
  })

  /** One key, one thing: Escape in the list closes the list, not the comment or the panel. */
  it('closes the list of people on Escape and nothing else', async () => {
    const { onDraftDone, onOpenChange } = renderPanel({ draft: DRAFT })
    const field = within(panel()).getByRole('combobox', { name: 'New comment' })

    await userEvent.type(field, '@')
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onDraftDone).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('puts the text back if the comment is refused', async () => {
    const comments = fakeComments({ create: vi.fn(async () => null) })
    renderPanel({ draft: DRAFT, comments })
    const field = within(panel()).getByRole('combobox', { name: 'New comment' })

    await userEvent.type(field, 'keep me')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')

    expect(comments.create).toHaveBeenCalled()
    expect(await screen.findByDisplayValue('keep me')).toBeInTheDocument()
  })
})
