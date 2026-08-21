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
 */
export function useDismissable(open, onDismiss, { containerRef, triggerRef, captureEscape = false } = {}) {
  useEffect(() => {
    if (!open) return undefined

    const onPointerDown = (event) => {
      if (!containerRef?.current?.contains(event.target)) onDismiss()
    }

    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
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
