import { useCallback, useEffect, useRef, useState } from 'react'
import { colorFor } from '../lib/identity.js'

const MORE_PATH =
  'M12 5.5 A1.6 1.6 0 1 1 12 2.3 A1.6 1.6 0 1 1 12 5.5 Z M12 13.6 A1.6 1.6 0 1 1 12 10.4 A1.6 1.6 0 1 1 12 13.6 Z M12 21.7 A1.6 1.6 0 1 1 12 18.5 A1.6 1.6 0 1 1 12 21.7 Z'

const LIVE_WINDOW_MS = 2 * 60 * 1000

function formatWhen(value) {
  if (!value) return 'never'
  const then = new Date(value)
  const minutes = Math.round((Date.now() - then.getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return minutes + 'm ago'
  if (minutes < 1440) return Math.round(minutes / 60) + 'h ago'
  return then.toLocaleDateString()
}

const isUnnamed = (room) => !room.name || room.name === 'Untitled room'

/**
 * One room on the dashboard.
 *
 * A room created without a name leads with its code instead of a shared
 * "Untitled room" label, so two unnamed rooms are never indistinguishable.
 * Management sits behind a menu so a stray click cannot rename or delete.
 */
export function RoomCard({ room, index = 0, onOpen, onShowPeople, onDelete, onRename, onToggleVisibility }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const triggerRef = useRef(null)

  const close = useCallback(() => setOpen(false), [])
  const unnamed = isUnnamed(room)
  const live = room.lastActivityAt && Date.now() - new Date(room.lastActivityAt).getTime() < LIVE_WINDOW_MS

  useEffect(() => {
    if (!open) return undefined

    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) close()
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        close()
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  const run = (action) => () => {
    close()
    action()
  }

  return (
    <li
      className="roomcard"
      style={{ '--i': index, '--identity': colorFor(room.roomId) }}
    >
      <span className="roomcard__stripe" aria-hidden="true" />

      <button type="button" className="roomcard__main" onClick={onOpen}>
        <span className="roomcard__title">
          {unnamed ? (
            <>
              <code className="roomcard__code">{room.roomId}</code>
              <span className="roomcard__unnamed">Unnamed</span>
            </>
          ) : (
            room.name
          )}
        </span>

        <span className="roomcard__meta">
          {!unnamed && <code className="roomcard__code">{room.roomId}</code>}

          <span className={room.isPublic ? 'pill pill--public' : 'pill'}>
            {room.isPublic ? 'Public' : 'Private'}
          </span>

          <span className="roomcard__stat">
            {room.memberCount} member{room.memberCount === 1 ? '' : 's'}
          </span>

          <span className="roomcard__stat">
            {live && <span className="livedot" aria-hidden="true" />}
            {live ? 'Active now' : 'Active ' + formatWhen(room.lastActivityAt)}
          </span>
        </span>
      </button>

      <div className="roomcard__menu" ref={containerRef}>
        <button
          type="button"
          className="roomcard__more"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={'Manage ' + (unnamed ? room.roomId : room.name)}
          ref={triggerRef}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d={MORE_PATH} fill="currentColor" />
          </svg>
        </button>

        {open && (
          <div className="popover popover--menu popover--anchored" role="menu">
            <button type="button" className="popover__item" role="menuitem" onClick={run(onRename)}>
              {unnamed ? 'Name this room' : 'Rename'}
            </button>
            <button
              type="button"
              className="popover__item"
              role="menuitem"
              onClick={run(onToggleVisibility)}
            >
              {room.isPublic ? 'Make private' : 'Make public'}
            </button>
            <button
              type="button"
              className="popover__item"
              role="menuitem"
              onClick={run(onShowPeople)}
            >
              People
            </button>
            <div className="popover__rule" />
            <button
              type="button"
              className="popover__item popover__item--danger"
              role="menuitem"
              onClick={run(onDelete)}
            >
              Delete room
            </button>
          </div>
        )}
      </div>
    </li>
  )
}
