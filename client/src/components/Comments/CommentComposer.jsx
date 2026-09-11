import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { colorFor } from '../../lib/identity.js'
import { insertMention, mentionQuery, mentionsIn } from '../../lib/comments.js'
import { Button } from '../ui/Button.jsx'

/**
 * Writing a comment, with @mentions.
 *
 * Typing @ opens a list of the people in the room, narrowed as the name is
 * typed. It is a real combobox — arrow keys move, Enter or Tab picks, Escape
 * closes the list without closing anything else — because a picker that only
 * works with a mouse is a picker half the room cannot use.
 *
 * Sending clears the field at once and puts the text back if the comment is
 * refused. Waiting for the server before clearing would make every comment
 * feel slow; clearing and losing a refused comment would be worse.
 */
export function CommentComposer({
  people = [],
  onSubmit,
  onCancel,
  submitLabel = 'Comment',
  placeholder = 'Add a comment…',
  label = 'Comment',
  initialText = '',
  autoFocus = false,
}) {
  const [text, setText] = useState(initialText)
  const [picked, setPicked] = useState([])
  const [query, setQuery] = useState(null)
  const [active, setActive] = useState(0)
  const fieldRef = useRef(null)
  const listId = useId()

  const matches = useMemo(() => {
    if (!query) return []
    const needle = query.query.toLowerCase()
    return people.filter((person) => person.name.toLowerCase().includes(needle)).slice(0, 6)
  }, [people, query])

  const open = matches.length > 0

  const read = (field) => {
    setQuery(mentionQuery(field.value, field.selectionStart ?? field.value.length))
    setActive(0)
  }

  const choose = (person) => {
    const field = fieldRef.current
    const caret = field?.selectionStart ?? text.length
    const next = insertMention(text, query.start, caret, person.name)

    caretRef.current = next.caret
    setText(next.text)
    setPicked((current) => (current.some((entry) => entry.id === person.id) ? current : [...current, person]))
    setQuery(null)
  }

  /**
   * The caret goes after the chosen name the moment the new text is on screen
   * — before the browser handles another keystroke.
   *
   * It used to wait for the next animation frame, and anything typed inside
   * that frame was split around the caret when it finally moved: "can you
   * confirm" typed straight after picking a name went out as "ou confirmcan y".
   */
  const caretRef = useRef(null)
  useLayoutEffect(() => {
    const caret = caretRef.current
    if (caret === null) return
    caretRef.current = null
    fieldRef.current?.focus()
    fieldRef.current?.setSelectionRange(caret, caret)
  }, [text])

  const submit = async () => {
    const body = text.trim()
    if (!body) return

    const mentions = mentionsIn(body, picked)
    setText('')
    setPicked([])
    setQuery(null)

    const ok = await onSubmit({ text: body, mentions })
    if (ok === false) setText(body)
  }

  const onKeyDown = (event) => {
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((current) => (current + step + matches.length) % matches.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        choose(matches[active])
        return
      }
      if (event.key === 'Escape') {
        // Closes the list and nothing else: the panel around it also listens
        // for Escape, and one key should do one thing.
        event.preventDefault()
        event.stopPropagation()
        setQuery(null)
        return
      }
    }

    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      submit()
      return
    }

    if (event.key === 'Escape' && onCancel) {
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <div className="composer">
      <div className="composer__field">
        <textarea
          ref={fieldRef}
          className="input composer__input"
          rows={2}
          value={text}
          placeholder={placeholder}
          aria-label={label}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open ? listId + '-' + active : undefined}
          onChange={(event) => {
            setText(event.target.value)
            read(event.target)
          }}
          onClick={(event) => read(event.target)}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
        />

        {open && (
          <ul id={listId} role="listbox" className="composer__mentions" aria-label="People to mention">
            {matches.map((person, index) => (
              <li
                key={person.id}
                id={listId + '-' + index}
                role="option"
                aria-selected={index === active}
                className={'composer__person' + (index === active ? ' is-active' : '')}
                // Mouse down, not click: a click would blur the field first and
                // the caret the mention is inserted at would be gone.
                onMouseDown={(event) => {
                  event.preventDefault()
                  choose(person)
                }}
              >
                <span
                  className="composer__avatar"
                  style={{ '--identity': colorFor(person.id) }}
                  aria-hidden="true"
                >
                  {person.name.slice(0, 1).toUpperCase()}
                </span>
                {person.name}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="composer__actions">
        <span className="composer__hint muted">@ to mention · Ctrl+Enter to send</span>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={submit} disabled={!text.trim()}>
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}
