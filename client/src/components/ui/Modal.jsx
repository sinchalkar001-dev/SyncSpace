import { useCallback, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Accessible dialog: labelled, modal to assistive tech, Escape to close, and
 * focus kept inside while open and restored to the opener on close.
 */
export function Modal({ open, title, description, children, onClose, initialFocusRef }) {
  const surfaceRef = useRef(null)
  const titleId = useId()
  const descriptionId = useId()

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose?.()
        return
      }
      if (event.key !== 'Tab') return

      const nodes = surfaceRef.current?.querySelectorAll(FOCUSABLE)
      if (!nodes || nodes.length === 0) return

      const first = nodes[0]
      const last = nodes[nodes.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [onClose]
  )

  useEffect(() => {
    if (!open) return undefined

    const opener = document.activeElement
    const target =
      initialFocusRef?.current || surfaceRef.current?.querySelector(FOCUSABLE) || surfaceRef.current
    target?.focus?.()

    return () => {
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [open, initialFocusRef])

  if (!open) return null

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.()
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        ref={surfaceRef}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <h2 className="modal__title" id={titleId}>
          {title}
        </h2>
        {description && (
          <p className="modal__description" id={descriptionId}>
            {description}
          </p>
        )}
        {children}
      </div>
    </div>,
    document.body
  )
}

/** Promise-free confirmation dialog; the caller owns the open state. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onClose,
}) {
  const confirmRef = useRef(null)

  return (
    <Modal open={open} title={title} description={description} onClose={onClose}>
      <div className="modal__actions">
        <button type="button" className="btn" onClick={onClose}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={destructive ? 'btn btn--danger' : 'btn btn--primary'}
          onClick={() => {
            onConfirm?.()
            onClose?.()
          }}
          ref={confirmRef}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
