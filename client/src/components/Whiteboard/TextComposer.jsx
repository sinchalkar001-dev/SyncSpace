import { useEffect, useRef } from 'react'

/**
 * Inline text entry on the canvas. Replaces window.prompt so the caret lands
 * where the user clicked and the surrounding UI stays usable.
 *
 * Enter commits, Shift+Enter adds a line, Escape cancels, blur commits.
 */
export function TextComposer({ draft, scale, color, fontSize, onChange, onCommit, onCancel }) {
  const ref = useRef(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  if (!draft) return null

  const onKeyDown = (event) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onCommit()
    }
  }

  return (
    <textarea
      ref={ref}
      className="text-composer"
      value={draft.value}
      aria-label="Text to place on the board"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onCommit}
      rows={1}
      style={{
        left: draft.screenX + 'px',
        top: draft.screenY + 'px',
        color,
        fontSize: Math.max(fontSize * scale, 10) + 'px',
      }}
    />
  )
}
