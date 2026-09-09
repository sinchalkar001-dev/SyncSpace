import { colorFor } from '../lib/identity.js'
import { formatWhen, isRoomLive, kindOf, roomLabel } from '../lib/rooms.js'
import { Button } from './ui/Button.jsx'
import { Icon } from './ui/Icon.jsx'

/**
 * The one room worth offering to go straight back into.
 *
 * A dashboard's real job, most of the time, is to get somebody out of it — you
 * are not here to browse rooms, you are here because you were in one twenty
 * minutes ago. So the most recently active room gets a strip of its own above
 * the grid, and everything on it is there to answer "is this the one":
 * its name, what it is for, who is in it, and whether anything is happening.
 *
 * It disappears rather than going stale. `continueRoom` returns nothing once
 * the newest room has been quiet for a week, because a prominent "resume"
 * pointing at a fortnight-old room is not resuming anything — and an empty
 * dashboard should say so plainly instead of dressing up an old room as a
 * session in progress.
 */
export function ContinueSession({ room, mine = true, onOpen, onShowPeople }) {
  if (!room) return null

  const kind = kindOf(room)
  const live = isRoomLive(room)
  const label = roomLabel(room)
  const people = room.collaborators ?? []
  const overflow = Math.max(0, (room.memberCount ?? 0) - people.length)

  return (
    <section
      className="continue"
      aria-labelledby="continue-title"
      style={{ '--identity': colorFor(room.roomId) }}
    >
      <div className="continue__body">
        <p className="continue__eyebrow" id="continue-title">
          <Icon name="redo" size={13} />
          Continue where you left off
        </p>

        <h2 className="continue__name">{label}</h2>

        {room.description && <p className="continue__desc">{room.description}</p>}

        <div className="continue__meta">
          <span className="pill pill--kind">
            <Icon name={kind.icon} size={11} />
            {kind.label}
          </span>

          <span className={room.isPublic ? 'pill pill--public' : 'pill'}>
            <Icon name={room.isPublic ? 'globe' : 'lock'} size={11} />
            {room.isPublic ? 'Public' : 'Private'}
          </span>

          {!mine && <span className="pill pill--quiet">Shared with you</span>}

          <span className="continue__stat">
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
        </div>
      </div>

      <div className="continue__side">
        {people.length > 0 && (
          <button
            type="button"
            className="continue__people"
            onClick={onShowPeople}
            aria-label={'People in ' + label}
          >
            <span className="roomcard__faces" aria-hidden="true">
              {people.map((person) => (
                <span
                  key={person.id}
                  className="roomcard__face"
                  style={{ '--identity': colorFor(person.id) }}
                >
                  {String(person.name || '?').slice(0, 1).toUpperCase()}
                </span>
              ))}
              {overflow > 0 && (
                <span className="roomcard__face roomcard__face--more">+{overflow}</span>
              )}
            </span>
          </button>
        )}

        <Button variant="primary" icon="arrowRight" onClick={onOpen}>
          Resume
        </Button>
      </div>
    </section>
  )
}
