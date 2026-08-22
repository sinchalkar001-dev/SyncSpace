import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui/Icon.jsx'

/** Substring match over the title, group and keywords — no fuzzy guessing. */
function matches(command, needle) {
  if (!needle) return true
  const haystack = (
    command.title +
    ' ' +
    (command.group || '') +
    ' ' +
    (command.keywords || '')
  ).toLowerCase()
  return needle.split(/\s+/).every((word) => haystack.includes(word))
}

/**
 * One entry point to everything the room can do.
 *
 * The alternative is more toolbar buttons, and the toolbar is already at the
 * limit of what stays scannable. Commands are supplied by the caller so this
 * component never reaches into the stores itself; it only filters, navigates
 * and runs.
 */
export function CommandPalette({ open, onClose, commands }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return commands.filter((command) => matches(command, needle))
  }, [commands, query])

  // A new search starts from the top; otherwise the highlight can sit past the
  // end of a shorter result list.
  useEffect(() => setActive(0), [query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
  }, [open])

  useEffect(() => {
    if (!open) return
    // Keep the highlighted row in view while arrowing through a long list.
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  if (!open) return null

  const run = (command) => {
    if (!command) return
    onClose()
    command.run()
  }

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (visible.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) => (index + delta + visible.length) % visible.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      run(visible[active])
    }
  }

  let lastGroup = null

  return createPortal(
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className="palette__search">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            className="palette__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command…"
            aria-label="Search commands"
            aria-controls="palette-list"
            autoFocus
          />
          <kbd className="palette__hint">Esc</kbd>
        </div>

        <div className="palette__list" id="palette-list" role="listbox" ref={listRef}>
          {visible.map((command, index) => {
            const heading = command.group !== lastGroup ? command.group : null
            lastGroup = command.group

            return (
              <div key={command.id}>
                {heading && <p className="palette__group">{heading}</p>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  className={'palette__item' + (index === active ? ' is-active' : '')}
                  onMouseMove={() => setActive(index)}
                  onClick={() => run(command)}
                >
                  <Icon name={command.icon || 'zap'} size={14} />
                  <span className="palette__label">{command.title}</span>
                  {command.detail && <span className="palette__detail">{command.detail}</span>}
                  {command.hint && <kbd className="palette__hint">{command.hint}</kbd>}
                </button>
              </div>
            )
          })}

          {visible.length === 0 && (
            <p className="palette__empty">Nothing matches “{query.trim()}”.</p>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
