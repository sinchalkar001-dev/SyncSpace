import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderHook, act } from '@testing-library/react'
import { ChatPanel } from './ChatPanel.jsx'
import { useRoomChat } from '../hooks/useRoomChat.js'

/**
 * Chat has always existed on the server — `room:chat` is validated, stamped
 * and broadcast — and nothing in the app listened for it or could send one.
 */

const ME = { id: 'u1', name: 'Ada', guest: false }
const THEM = { id: 'u2', name: 'Grace', guest: false }

const line = (from, text, key) => ({
  key,
  from,
  text,
  at: '2026-09-03T10:15:00.000Z',
  mine: from.id === ME.id,
})

function renderPanel({ messages = [], unread = 0, onSend = () => true, open = true } = {}) {
  const onOpenChange = vi.fn()
  const view = render(
    <ChatPanel
      messages={messages}
      unread={unread}
      onSend={onSend}
      open={open}
      onOpenChange={onOpenChange}
    />
  )
  return { ...view, onOpenChange }
}

describe('ChatPanel', () => {
  it('shows the transcript, with who said what', () => {
    renderPanel({ messages: [line(THEM, 'is this thing on?', 1), line(ME, 'loud and clear', 2)] })

    const panel = screen.getByRole('dialog', { name: 'Room chat' })
    expect(within(panel).getByText('is this thing on?')).toBeInTheDocument()
    expect(within(panel).getByText('Grace')).toBeInTheDocument()
    expect(within(panel).getByText('loud and clear')).toBeInTheDocument()
  })

  /**
   * Nothing is stored on either side, so an empty panel is the normal state
   * for anyone who just joined rather than a sign that chat is broken.
   */
  it('says why an empty transcript is empty', () => {
    renderPanel()
    expect(screen.getByText(/not kept/i)).toBeInTheDocument()
  })

  it('sends what was typed and clears the field', async () => {
    const onSend = vi.fn(() => true)
    renderPanel({ onSend })

    const field = screen.getByLabelText('Message the room')
    await userEvent.type(field, 'shall we start?')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledWith('shall we start?')
    await waitFor(() => expect(field).toHaveValue(''))
  })

  it('keeps the draft when the message could not be sent', async () => {
    renderPanel({ onSend: () => false })

    const field = screen.getByLabelText('Message the room')
    await userEvent.type(field, 'no connection{Enter}')

    expect(field).toHaveValue('no connection')
  })

  it('will not send an empty message', async () => {
    const onSend = vi.fn(() => true)
    renderPanel({ onSend })

    await userEvent.type(screen.getByLabelText('Message the room'), '   ')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('counts unread messages on the closed trigger', () => {
    renderPanel({ open: false, unread: 3 })

    expect(screen.getByRole('button', { name: 'Chat (3 unread)' })).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('caps the badge rather than letting it widen the header', () => {
    renderPanel({ open: false, unread: 42 })
    expect(screen.getByText('9+')).toBeInTheDocument()
  })
})

describe('useRoomChat', () => {
  const setup = (open = false) => {
    const emit = vi.fn()
    const socketRef = { current: { emit } }
    const view = renderHook(
      ({ isOpen }) => useRoomChat({ roomId: 'r1', socketRef, self: ME, open: isOpen }),
      { initialProps: { isOpen: open } }
    )
    return { ...view, emit }
  }

  it('emits on the room socket the rest of the room already uses', () => {
    const { result, emit } = setup()

    act(() => {
      result.current.send('  hello  ')
    })

    expect(emit).toHaveBeenCalledWith('room:chat', { roomId: 'r1', text: 'hello' })
  })

  it('refuses to send nothing', () => {
    const { result, emit } = setup()

    act(() => {
      expect(result.current.send('   ')).toBe(false)
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it('collects what the room broadcasts', () => {
    const { result } = setup()

    act(() => {
      result.current.receive({ from: THEM, text: 'morning', at: '2026-09-03T10:00:00.000Z' })
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0]).toMatchObject({ text: 'morning', mine: false })
  })

  /** The server echoes your own message back; it is not news to you. */
  it('does not count your own message as unread', () => {
    const { result } = setup(false)

    act(() => {
      result.current.receive({ from: ME, text: 'mine', at: '2026-09-03T10:00:00.000Z' })
    })

    expect(result.current.messages[0].mine).toBe(true)
    expect(result.current.unread).toBe(0)
  })

  it('counts messages that arrive while the panel is shut', () => {
    const { result } = setup(false)

    act(() => {
      result.current.receive({ from: THEM, text: 'one', at: '' })
      result.current.receive({ from: THEM, text: 'two', at: '' })
    })

    expect(result.current.unread).toBe(2)
  })

  it('clears the count once the panel is opened', () => {
    const { result, rerender } = setup(false)

    act(() => {
      result.current.receive({ from: THEM, text: 'one', at: '' })
    })
    expect(result.current.unread).toBe(1)

    rerender({ isOpen: true })
    expect(result.current.unread).toBe(0)
  })

  it('does not count a message you are already looking at', () => {
    const { result } = setup(true)

    act(() => {
      result.current.receive({ from: THEM, text: 'seen', at: '' })
    })

    expect(result.current.unread).toBe(0)
  })
})
