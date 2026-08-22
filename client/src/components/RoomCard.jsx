import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { colorFor } from '../lib/identity.js'
import { formatWhen, isRoomLive, isUnnamed } from '../lib/rooms.js'
import { useDismissable } from '../hooks/useDismissable.js'
import { Icon } from './ui/Icon.jsx'

// The gap between trigger and menu, from .popover--anchored.
const MENU_GAP = 6
const VIEWPORT_MARGIN = 8

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

  const toggle = useCallback(() => setOpen((value) => !value), [])

  /**
   * Decides which side the menu opens on, from the real menu once it exists.
   *
   * A popover is absolutely positioned, so it adds nothing to the page's
   * scroll height: one hanging past the bottom edge cannot be scrolled to at
   * all. Height comes from `offsetHeight` rather than the bounding box because
   * the menu animates in with a scale, and the box during that animation is
   * smaller than the menu it is about to become.
   *
   * As a layout effect this runs before the browser paints, so a flip is never
   * seen as a jump.
   */
  useLayoutEffect(() => {
    if (!open) return undefined

    const place = () => {
      const menu = containerRef.current?.querySelector('.popover--menu')
      const trigger = triggerRef.current
      if (!menu || !trigger) return

      const height = menu.offsetHeight
      const box = trigger.getBoundingClientRect()
      const overflowsBelow = box.bottom + MENU_GAP + height > window.innerHeight - VIEWPORT_MARGIN
      const fitsAbove = box.top - MENU_GAP - height > VIEWPORT_MARGIN

      setAbove(overflowsBelow && fitsAbove)
    }

    place()

    // One measurement is not enough. The page can still be scrolling when the
    // menu opens, and the dashboard settles its own layout a frame or two
    // later, so a decision taken on the click alone can be about a position
    // the card no longer holds.
    const frame = requestAnimationFrame(place)
    const observer = new ResizeObserver(place)
    observer.observe(document.body)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  const run = (action) => () => {
    close()
    action()
  }

  return (
    <li
      className={'roomcard' + (open ? ' roomcard--open' : '')}
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
