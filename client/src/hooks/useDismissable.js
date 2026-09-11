import { useEffect } from 'react'

/**
 * Closes a popover, menu, or dropdown on an outside click or Escape, and
 * returns focus to whatever opened it.
 *
 * This was written three separate times — in UserMenu, RoomCard, and the tool
 * rail — with small inconsistencies each way. One implementation means one set
 * of behaviour to get right.
 *
 * `captureEscape` listens on the capture phase and stops propagation, for
 * popovers layered over something that also handles Escape: the whiteboard
 * clears its selection on Escape, and closing the style popover must not do
 * both at once.
 *
 * An expanded combobox inside the popover gets Escape first, as the ARIA
 * combobox pattern says it should: Escape closes its list of suggestions, and
 * only a second Escape closes the popover around it. Without this the
 * capture-phase listener would close the whole panel before the field could
 * close its own list.
 */
const ownsEscape = (target) =>
  target instanceof Element && Boolean(target.closest('[role="combobox"][aria-expanded="true"]'))

export function useDismissable(open, onDismiss, { containerRef, triggerRef, captureEscape = false } = {}) {
  useEffect(() => {
    if (!open) return undefined

    /**
     * Asked of the path the event travelled, not of the tree as it stands now.
     * A press inside can remove its own target before the event bubbles up to
     * the document — picking a person from the mention list does exactly that
     * — and a node that has left the tree is not "inside" anything, so the
     * popover used to close under the click that was using it.
     */
    const inside = (event) => {
      const container = containerRef?.current
      if (!container) return false
      const path = event.composedPath?.()
      return path?.length ? path.includes(container) : container.contains(event.target)
    }

    const onPointerDown = (event) => {
      if (!inside(event)) onDismiss()
    }

    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      if (ownsEscape(event.target)) return
      if (captureEscape) event.stopPropagation()
      onDismiss()
      triggerRef?.current?.focus()
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, captureEscape)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, captureEscape)
    }
  }, [open, onDismiss, containerRef, triggerRef, captureEscape])
}
