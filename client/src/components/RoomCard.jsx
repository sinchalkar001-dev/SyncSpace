import { useCallback, useEffect, useRef, useState } from 'react'

const MORE_PATH =
  'M12 5.5 A1.6 1.6 0 1 1 12 2.3 A1.6 1.6 0 1 1 12 5.5 Z M12 13.6 A1.6 1.6 0 1 1 12 10.4 A1.6 1.6 0 1 1 12 13.6 Z M12 21.7 A1.6 1.6 0 1 1 12 18.5 A1.6 1.6 0 1 1 12 21.7 Z'

function formatWhen(value) {
  if (!value) return 'never'
  const then = new Date(value)
  const minutes = Math.round((Date.now() - then.getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return minutes + 'm ago'
  if (minutes < 1440) return Math.round(minutes / 60) + 'h ago'
  return then.toLocaleDateString()
}

/**
 * One room on the dashboard. The card body opens the room; management lives
 * in its own menu so a stray click never deletes anything.
 */
export function RoomCard({ room, onOpen, onShowPeople, onDelete }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const triggerRef = useRef(null)

  const close = useCallback(() => setOpen(false), [])

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

  return (
    <li className="roomcard">
      <button type="button" className="roomcard__main" onClick={onOpen}>
        <span className="roomcard__name">{room.name}</span>
        <span className="roomcard__meta">
          <code>{room.roomId}</code>
          <span>{room.isPublic ? 'Public' : 'Private'}</span>
          <span>
            {room.memberCount} member{room.memberCount === 1 ? '' : 's'}
          </span>
          <span>Active {formatWhen(room.lastActivityAt)}</span>
        </span>
      </button>

      <div className="roomcard__menu" ref={containerRef}>
        <button
          type="button"
          className="roomcard__more"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={'Manage ' + room.name}
          ref={triggerRef}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d={MORE_PATH} fill="currentColor" />
          </svg>
        </button>

        {open && (
          <div className="popover popover--menu popover--anchored" role="menu">
            <button
              type="button"
              className="popover__item"
              role="menuitem"
              onClick={() => {
                close()
                onShowPeople()
              }}
            >
              People
            </button>
            <button
              type="button"
              className="popover__item popover__item--danger"
              role="menuitem"
              onClick={() => {
                close()
                onDelete()
              }}
            >
              Delete room
            </button>
          </div>
        )}
      </div>
    </li>
  )
}
