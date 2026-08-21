import { memo, useCallback, useRef, useState } from 'react'
import { colorFor } from '../lib/identity.js'
import { formatWhen, isRoomLive, isUnnamed } from '../lib/rooms.js'
import { useDismissable } from '../hooks/useDismissable.js'
import { Icon } from './ui/Icon.jsx'

// Roughly the menu's height plus breathing room.
const MENU_CLEARANCE = 210

/**
 * One room on the dashboard.
 *
 * A room created without a name leads with its code instead of a shared
 * "Untitled room" label, so two unnamed rooms are never indistinguishable.
 * Management sits behind a menu so a stray click cannot rename or delete.
 *
 * Memoised because the dashboard re-renders the whole list on every keystroke
 * in the search box, and only the matching subset actually changes.
 */
function RoomCardBase({
  room,
  index = 0,
  onOpen,
  onShowPeople,
  onDelete,
  onRename,
  onToggleVisibility,
}) {
  const [open, setOpen] = useState(false)
  // The menu opens downward by default, but the last card on a short screen
  // has no room below and nothing to scroll, so it flips upward instead.
  const [above, setAbove] = useState(false)
  const containerRef = useRef(null)
  const triggerRef = useRef(null)

  const close = useCallback(() => setOpen(false), [])
  useDismissable(open, close, { containerRef, triggerRef })

  const unnamed = isUnnamed(room)
  const live = isRoomLive(room)

  const toggle = useCallback(() => {
    setOpen((value) => {
      if (value) return false
      const rect = triggerRef.current?.getBoundingClientRect()
      const spaceBelow = window.innerHeight - (rect?.bottom ?? 0)
      setAbove(spaceBelow < MENU_CLEARANCE)
      return true
    })
  }, [])

  const run = (action) => () => {
    close()
    action()
  }

  return (
    <li className="roomcard" style={{ '--i': index, '--identity': colorFor(room.roomId) }}>
      <span className="roomcard__stripe" aria-hidden="true" />

      <button type="button" className="roomcard__main" onClick={onOpen}>
        <span className="roomcard__title">
          {unnamed ? (
            <>
              <code className="roomcard__code">{room.roomId}</code>
              <span className="roomcard__unnamed">Unnamed</span>
            </>
          ) : (
            <span>{room.name}</span>
          )}
        </span>

        <span className="roomcard__meta">
          {!unnamed && <code className="roomcard__code">{room.roomId}</code>}

          <span className={room.isPublic ? 'pill pill--public' : 'pill'}>
            <Icon name={room.isPublic ? 'globe' : 'lock'} size={11} />
            {room.isPublic ? 'Public' : 'Private'}
          </span>

          <span className="roomcard__stat">
            <Icon name="users" size={13} />
            {room.memberCount} member{room.memberCount === 1 ? '' : 's'}
          </span>

          <span className="roomcard__stat">
            {live ? (
              <>
                <span className="livedot" aria-hidden="true" />
                Active now
              </>
            ) : (
              <>
                <Icon name="clock" size={13} />
                {'Active ' + formatWhen(room.lastActivityAt)}
              </>
            )}
          </span>
        </span>
      </button>

      <div className="roomcard__menu" ref={containerRef}>
        <button
          type="button"
          className="roomcard__more"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={'Manage ' + (unnamed ? room.roomId : room.name)}
          ref={triggerRef}
        >
          <Icon name="more" size={16} />
        </button>

        {open && (
          <div
            className={
              'popover popover--menu popover--anchored' + (above ? ' popover--above' : '')
            }
            role="menu"
          >
            <button type="button" className="popover__item" role="menuitem" onClick={run(onRename)}>
              <Icon name="pen" size={14} />
              {unnamed ? 'Name this room' : 'Rename'}
            </button>
            <button
              type="button"
              className="popover__item"
              role="menuitem"
              onClick={run(onToggleVisibility)}
            >
              <Icon name={room.isPublic ? 'lock' : 'globe'} size={14} />
              {room.isPublic ? 'Make private' : 'Make public'}
            </button>
            <button
              type="button"
              className="popover__item"
              role="menuitem"
              onClick={run(onShowPeople)}
            >
              <Icon name="users" size={14} />
              People
            </button>
            <div className="popover__rule" />
            <button
              type="button"
              className="popover__item popover__item--danger"
              role="menuitem"
              onClick={run(onDelete)}
            >
              <Icon name="trash" size={14} />
              Delete room
            </button>
          </div>
        )}
      </div>
    </li>
  )
}

export const RoomCard = memo(RoomCardBase)
