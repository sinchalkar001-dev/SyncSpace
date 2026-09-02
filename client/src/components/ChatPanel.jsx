import { useCallback, useEffect, useRef, useState } from 'react'
import { useDismissable } from '../hooks/useDismissable.js'
import { Avatar } from './PeopleList.jsx'
import { Button } from './ui/Button.jsx'
import { Icon } from './ui/Icon.jsx'
import { colorFor } from '../lib/identity.js'

/** Wall-clock time, which is all a chat line needs. */
const at = (iso) => {
  if (!iso) return ''
  const when = new Date(iso)
  return Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Talking to the room, without leaving it.
 *
 * The server has always broadcast `room:chat` and there was nowhere to read or
 * write one, so the only way to say anything to the person you were drawing
 * with was to type it into the shared code buffer. It sits behind a button in
 * the header like the roster does, and carries an unread count so a message
 * arriving while it is shut is not missed.
 *
 * Nothing is persisted, on either side — the transcript starts empty on join,
 * and the panel says so rather than looking broken.
 */
export function ChatPanel({ messages, unread, onSend, open, onOpenChange }) {
  const [draft, setDraft] = useState('')
  const containerRef = useRef(null)
  const triggerRef = useRef(null)
  const listRef = useRef(null)
  const inputRef = useRef(null)

  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  useDismissable(open, close, { containerRef, triggerRef, captureEscape: true })

  // Pinned to the newest line, which is the one people are waiting for.
  useEffect(() => {
    if (!open || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [open, messages])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const submit = (event) => {
    event.preventDefault()
    if (onSend(draft)) setDraft('')
  }

  const label = 'Chat' + (unread > 0 ? ' (' + unread + ' unread)' : '')

  return (
    <div className="presence-menu" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="presence-menu__trigger"
        aria-label={label}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <Icon name="inbox" size={16} />
        {unread > 0 && <span className="chat__badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="presence-menu__panel chat" role="dialog" aria-label="Room chat">
          <h3 className="people__heading">Chat</h3>

          <div className="chat__log" ref={listRef}>
            {messages.length === 0 ? (
              <p className="muted people__empty">
                Nothing yet. Messages are live only — they are not kept, and anyone joining later
                starts from here.
              </p>
            ) : (
              <ul className="chat__list">
                {messages.map((message) => (
                  <li key={message.key} className={message.mine ? 'chat__line is-mine' : 'chat__line'}>
                    <Avatar
                      name={message.from?.name}
                      color={colorFor(message.from?.id)}
                      muted={message.from?.guest}
                    />
                    <span className="chat__body">
                      <span className="chat__who">
                        <strong>{message.from?.name || 'Someone'}</strong>
                        <span className="muted nums">{at(message.at)}</span>
                      </span>
                      <span className="chat__text">{message.text}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <form className="chat__compose" onSubmit={submit}>
            <input
              ref={inputRef}
              className="input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message the room"
              aria-label="Message the room"
              maxLength={2000}
            />
            <Button type="submit" variant="primary" icon="arrowRight" disabled={!draft.trim()}>
              Send
            </Button>
          </form>
        </div>
      )}
    </div>
  )
}
