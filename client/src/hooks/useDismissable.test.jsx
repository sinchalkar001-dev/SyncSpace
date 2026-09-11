import { useRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDismissable } from './useDismissable.js'

/**
 * Closing a popover: on a press outside it, or on Escape — and never under a
 * press that is using it.
 */

function Popover({ onDismiss, captureEscape = true }) {
  const containerRef = useRef(null)
  const triggerRef = useRef(null)
  useDismissable(true, onDismiss, { containerRef, triggerRef, captureEscape })

  return (
    <div>
      <button ref={triggerRef}>Open</button>
      <div ref={containerRef}>
        <button>Pick</button>
        <textarea role="combobox" aria-expanded="true" aria-label="Field with its list open" />
        <textarea role="combobox" aria-expanded="false" aria-label="Field with its list closed" />
      </div>
      <p>Elsewhere</p>
    </div>
  )
}

describe('useDismissable', () => {
  it('closes on a press outside', () => {
    const onDismiss = vi.fn()
    render(<Popover onDismiss={onDismiss} />)

    fireEvent.mouseDown(screen.getByText('Elsewhere'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('stays open on a press inside', () => {
    const onDismiss = vi.fn()
    render(<Popover onDismiss={onDismiss} />)

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Pick' }))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  /**
   * The mention list: pressing a person removes the list, and the person with
   * it, before the press reaches the document. It was still a press inside.
   */
  it('stays open when the press removes its own target on the way up', () => {
    const onDismiss = vi.fn()
    render(<Popover onDismiss={onDismiss} />)

    const pick = screen.getByRole('button', { name: 'Pick' })
    pick.addEventListener('mousedown', () => pick.remove())
    fireEvent.mouseDown(pick)

    expect(pick.isConnected).toBe(false)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const onDismiss = vi.fn()
    render(<Popover onDismiss={onDismiss} />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Pick' }), { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  /** An open list of suggestions gets Escape first, as the ARIA combobox pattern says. */
  it('leaves Escape to a field whose list is open', () => {
    const onDismiss = vi.fn()
    render(<Popover onDismiss={onDismiss} />)

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Field with its list open' }), { key: 'Escape' })
    expect(onDismiss).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Field with its list closed' }), { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
