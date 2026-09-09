import { memo, useMemo } from 'react'
import { activityDetail, activityIcon, describeActivity } from '../lib/activity.js'
import { formatWhen, roomLabel } from '../lib/rooms.js'
import { Icon } from './ui/Icon.jsx'
import { Skeleton } from './ui/Skeleton.jsx'

/**
 * What has been happening, across every room this account is in.
 *
 * The dashboard could already say when a room was last touched and nothing at
 * all about what was done to it, which is the difference between "something
 * changed" and a reason to open it. Each line names the person, the thing they
 * did, and the room it happened in — the room included because this feed spans
 * all of them and a line without one is unreadable.
 *
 * Every row is a link back to its room, so reading the feed and acting on it
 * are the same gesture rather than two.
 *
 * Its own failure states, deliberately. The feed is a panel beside the rooms
 * rather than the page itself, and it going missing must not read as the
 * dashboard being broken — so a failure here says so quietly and leaves the
 * rooms alone.
 */
function ActivityFeedBase({ state, events = [], rooms = [], onOpenRoom }) {
  // Rooms arrive separately from their events, so the name is resolved here
  // rather than denormalised into every row on the server.
  const names = useMemo(() => {
    const map = new Map()
    for (const room of rooms) map.set(room.roomId, roomLabel(room))
    return map
  }, [rooms])

  return (
    <section className="feed" aria-labelledby="feed-title">
      <div className="feed__head">
        <h2 className="section__title" id="feed-title">
          Recent activity
        </h2>
      </div>

      {state === 'loading' && (
        <>
          <span className="sr-only" role="status">
            Loading recent activity
          </span>
          <ul className="feed__list" aria-hidden="true">
            {[0, 1, 2, 3].map((row) => (
              <li className="feed__item" key={row}>
                <Skeleton width={`${60 + row * 8}%`} />
              </li>
            ))}
          </ul>
        </>
      )}

      {state === 'error' && (
        <p className="feed__empty muted">
          Could not load recent activity. Your rooms are unaffected.
        </p>
      )}

      {state === 'ready' && events.length === 0 && (
        <p className="feed__empty muted">
          Nothing yet. Edits, runs and people joining will show up here.
        </p>
      )}

      {state === 'ready' && events.length > 0 && (
        <ul className="feed__list">
          {events.map((event) => {
            const detail = activityDetail(event)

            return (
              <li className="feed__item" key={event.id}>
                <button
                  type="button"
                  className="feed__link"
                  onClick={() => onOpenRoom?.(event.roomId)}
                >
                  <span className="feed__icon" aria-hidden="true">
                    <Icon name={activityIcon(event)} size={13} />
                  </span>

                  <span className="feed__text">
                    <span className="feed__what">{describeActivity(event)}</span>
                    <span className="feed__where">
                      {names.get(event.roomId) ?? event.roomId}
                      <span aria-hidden="true"> · </span>
                      {formatWhen(event.at)}
                    </span>
                    {detail && <span className="feed__detail">{detail}</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export const ActivityFeed = memo(ActivityFeedBase)
