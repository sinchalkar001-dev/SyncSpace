import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './CommandPalette.jsx'

function makeCommands(run = vi.fn()) {
  return [
    { id: 'a', group: 'View', title: 'Board only', run },
    { id: 'b', group: 'View', title: 'Code only', run },
    { id: 'c', group: 'Editor', title: 'Toggle word wrap', keywords: 'wrap lines', run },
  ]
}

describe('CommandPalette', () => {
  it('renders nothing until it is opened', () => {
    const { container } = render(
      <CommandPalette open={false} onClose={vi.fn()} commands={makeCommands()} />
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('filters on the title and on keywords that are never displayed', async () => {
    const user = userEvent.setup()
    render(<CommandPalette open onClose={vi.fn()} commands={makeCommands()} />)

    await user.type(screen.getByRole('textbox'), 'only')
    expect(screen.getAllByRole('option')).toHaveLength(2)

    await user.clear(screen.getByRole('textbox'))
    // 'lines' appears only in keywords, so a match proves those are searched.
    await user.type(screen.getByRole('textbox'), 'lines')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option')).toHaveTextContent('Toggle word wrap')
  })

  it('runs the highlighted command with Enter and closes first', async () => {
    const user = userEvent.setup()
    const order = []
    const run = () => order.push('run')
    const onClose = () => order.push('close')

    render(
      <CommandPalette
        open
        onClose={onClose}
        commands={[{ id: 'a', group: 'View', title: 'Board only', run }]}
      />
    )

    await user.keyboard('{Enter}')
    // Closing before running keeps focus restoration from fighting whatever
    // the command itself focuses.
    expect(order).toEqual(['close', 'run'])
  })

  it('moves the highlight with the arrow keys and wraps at the ends', async () => {
    const user = userEvent.setup()
    render(<CommandPalette open onClose={vi.fn()} commands={makeCommands()} />)

    const selected = () => screen.getAllByRole('option').findIndex((n) => n.dataset.active === 'true')

    expect(selected()).toBe(0)
    await user.keyboard('{ArrowDown}')
    expect(selected()).toBe(1)
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(selected()).toBe(2)
  })

  it('resets the highlight when the query narrows the list', async () => {
    const user = userEvent.setup()
    render(<CommandPalette open onClose={vi.fn()} commands={makeCommands()} />)

    await user.keyboard('{ArrowDown}{ArrowDown}')
    await user.type(screen.getByRole('textbox'), 'only')

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    // Without the reset the highlight would still be on index 2, past the end.
    expect(options[0].dataset.active).toBe('true')
  })

  it('says so when nothing matches', async () => {
    const user = userEvent.setup()
    render(<CommandPalette open onClose={vi.fn()} commands={makeCommands()} />)

    await user.type(screen.getByRole('textbox'), 'zzz')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(/nothing matches/i)).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<CommandPalette open onClose={onClose} commands={makeCommands()} />)

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
