import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { colorFor } from '../lib/identity.js'
import { formatWhen, isRoomLive, isUnnamed, kindOf, roomLabel } from '../lib/rooms.js'
import { useDismissable } from '../hooks/useDismissable.js'
import { Icon } from './ui/Icon.jsx'

// The gap between trigger and menu, from .popover--anchored.
const MENU_GAP = 6
const VIEWPORT_MARGIN = 8

/**
 * The people in a room, as a stack of initials.
 *
 * A count said "3 members" and left you no wiser about whose room this was.
 * Names are the thing being conveyed, so they are the accessible text too —
 * the stack is one labelled group rather than a row of images, which is what
 * stops a screen reader reading four separate letters.
 */
function Faces({ people = [], total = 0 }) {
  if (!people.length) return null

  const overflow = Math.max(0, total - people.length)
  const names = people.map((person) => person.name || 'Someone').join(', ')

  return (
    <span
      className="roomcard__faces"
      role="img"
      aria-label={names + (overflow ? ' and ' + overflow + ' more' : '')}
    >
      {people.map((person) => (
        <span
          key={person.id}
          className="roomcard__face"
          style={{ '--identity': colorFor(person.id) }}
          aria-hidden="true"
        >
          {String(person.name || '?').slice(0, 1).toUpperCase()}
        </span>
      ))}
      {overflow > 0 && (
        <span className="roomcard__face roomcard__face--more" aria-hidden="true">
          +{overflow}
        </span>
      )}
    </span>
  )
}

/**
 * One room on the dashboard.
 *
 * A card has to answer, without being opened: what is this, what is it for,
 * who else is in it, and is anything happening. The room's kind and its
 * description carry the first two — a grid of names alone made every room look
 * the same, which is the problem forty rooms actually have.
 *
 * A room created without a name leads with its code instead of a shared
 * "Untitled room" label, so two unnamed rooms are never indistinguishable.
 * Management sits behind a menu so a stray click cannot rename or delete;
 * pinning is the exception and sits on the card, because it is reversible,
 * private to you, and the one thing people do repeatedly.
 *
 * Memoised because the dashboard re-renders the whole list on every keystroke
 * in the search box, and only the matching subset actually changes. That only
 * works if the props hold still, which is why every handler here takes the room
 * as an argument rather than closing over it: a parent building
 * `() => open(room)` per card hands every card a new function on every render,
 * and `memo` compares those and re-renders all of them anyway.
 */
function RoomCardBase({
  room,
  index = 0,
  mine = true,
  onOpen,
  onShowPeople,
  onDelete,
  onRename,
  onToggleVisibility,
  onTogglePin,
  onToggleArchive,
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
  const kind = kindOf(room)
  const label = roomLabel(room)

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

  const classes = [
    'roomcard',
    open ? 'roomcard--open' : '',
    room.pinned ? 'roomcard--pinned' : '',
    room.archived ? 'roomcard--archived' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li className={classes} style={{ '--i': index, '--identity': colorFor(room.roomId) }}>
      <span className="roomcard__stripe" aria-hidden="true" />

      <button type="button" className="roomcard__main" onClick={() => onOpen(room)}>
        <span className="roomcard__top">
          <span className="roomcard__kind">
            <Icon name={kind.icon} size={12} />
            {kind.label}
          </span>

          {live && (
            <span className="roomcard__live">
              <span className="livedot" aria-hidden="true" />
              Active now
            </span>
          )}

          {room.archived && <span className="pill pill--quiet">Archived</span>}
          {!mine && <span className="pill pill--quiet">Shared</span>}
        </span>

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

        {/* The placeholder is deliberately an instruction, not filler: an
            empty line here is the most common state, and saying nothing wastes
            the one place that could explain what the room is. */}
        <span className={room.description ? 'roomcard__desc' : 'roomcard__desc roomcard__desc--empty'}>
          {room.description || 'No description yet'}
        </span>

        <span className="roomcard__meta">
          {!unnamed && <code className="roomcard__code">{room.roomId}</code>}

          <span className={room.isPublic ? 'pill pill--public' : 'pill'}>
            <Icon name={room.isPublic ? 'globe' : 'lock'} size={11} />
            {room.isPublic ? 'Public' : 'Private'}
          </span>

          <Faces people={room.collaborators} total={room.memberCount} />

          <span className="roomcard__stat">
            <Icon name="clock" size={13} />
            {live ? 'Active now' : 'Active ' + formatWhen(room.lastActivityAt)}
          </span>

          {room.updatedAt && (
            <span className="roomcard__stat roomcard__stat--quiet">
              <Icon name="pen" size={12} />
              {'Changed ' + formatWhen(room.updatedAt)}
            </span>
          )}
        </span>
      </button>

      <div className="roomcard__tools">
        {/* On the card rather than in the menu: private to you, instantly
            reversible, and the one control people use over and over. */}
        <button
          type="button"
          className={'roomcard__pin' + (room.pinned ? ' roomcard__pin--on' : '')}
          onClick={() => onTogglePin(room)}
          aria-pressed={Boolean(room.pinned)}
          aria-label={(room.pinned ? 'Unpin ' : 'Pin ') + label}
          title={room.pinned ? 'Unpin from the top' : 'Pin to the top'}
        >
          <Icon name="pin" size={15} />
        </button>

        <div className="roomcard__menu" ref={containerRef}>
          <button
            type="button"
            className="roomcard__more"
            onClick={toggle}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label={'Manage ' + label}
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
              <button type="button" className="popover__item" role="menuitem" onClick={run(() => onRename(room))}>
                <Icon name="pen" size={14} />
                {unnamed ? 'Name this room' : 'Rename'}
              </button>
              <button
                type="button"
                className="popover__item"
                role="menuitem"
                onClick={run(() => onToggleVisibility(room))}
              >
                <Icon name={room.isPublic ? 'lock' : 'globe'} size={14} />
                {room.isPublic ? 'Make private' : 'Make public'}
              </button>
              <button
                type="button"
                className="popover__item"
                role="menuitem"
                onClick={run(() => onShowPeople(room))}
              >
                <Icon name="users" size={14} />
                People
              </button>
              <div className="popover__rule" />
              <button
                type="button"
                className="popover__item"
                role="menuitem"
                onClick={run(() => onToggleArchive(room))}
              >
                <Icon name={room.archived ? 'redo' : 'archive'} size={14} />
                {room.archived ? 'Unarchive' : 'Archive'}
              </button>
              <button
                type="button"
                className="popover__item popover__item--danger"
                role="menuitem"
                onClick={run(() => onDelete(room))}
              >
                <Icon name="trash" size={14} />
                Delete room
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

export const RoomCard = memo(RoomCardBase)
