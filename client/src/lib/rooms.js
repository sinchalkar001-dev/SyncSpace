/**
 * Room helpers shared by the dashboard, the room card, and the people dialog.
 *
 * `formatWhen` previously existed as two identical copies in RoomCard.jsx and
 * RoomPeopleDialog.jsx. Every derived figure the dashboard shows is computed
 * here from the `/api/rooms` payload the page already fetches — there is no
 * separate stats endpoint, and adding one is not this change's business.
 */

/** A room counts as live if it saw activity in the last two minutes. */
export const LIVE_WINDOW_MS = 2 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

export function formatWhen(value) {
  if (!value) return 'never'
  const then = new Date(value)
  const minutes = Math.round((Date.now() - then.getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return minutes + 'm ago'
  if (minutes < 1440) return Math.round(minutes / 60) + 'h ago'
  return then.toLocaleDateString()
}

export function isRoomLive(room) {
  return Boolean(
    room?.lastActivityAt && Date.now() - new Date(room.lastActivityAt).getTime() < LIVE_WINDOW_MS
  )
}

export const isUnnamed = (room) => !room?.name || room.name === 'Untitled room'

/** What a room is called when it has no name of its own. */
export const roomLabel = (room) => (isUnnamed(room) ? room.roomId : room.name)

/** Headline figures for the dashboard overview. */
export function summarise(rooms) {
  return {
    total: rooms.length,
    live: rooms.filter(isRoomLive).length,
    collaborators: rooms.reduce((sum, room) => sum + (room.memberCount || 0), 0),
    publicCount: rooms.filter((room) => room.isPublic).length,
  }
}

/**
 * Rooms bucketed by day of last activity, oldest first, for the sparkline.
 * A room only ever lands in one bucket — this is "when was each room last
 * touched", not a full activity history, which the update log would need.
 */
export function activityByDay(rooms, days = 7) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  return Array.from({ length: days }, (_, offset) => {
    const start = today.getTime() - (days - 1 - offset) * DAY_MS
    const end = start + DAY_MS

    return {
      label: new Date(start).toLocaleDateString(undefined, { weekday: 'short' }),
      value: rooms.filter((room) => {
        if (!room.lastActivityAt) return false
        const at = new Date(room.lastActivityAt).getTime()
        return at >= start && at < end
      }).length,
      isToday: offset === days - 1,
    }
  })
}

export const FILTERS = [
  { value: 'all', label: 'All rooms' },
  { value: 'live', label: 'Active' },
  // These read "… rooms" deliberately: a bare "Public"/"Private" would collide
  // with the badge text on every card when queried by exact text.
  { value: 'public', label: 'Public rooms' },
  { value: 'private', label: 'Private rooms' },
]

export const SORTS = [
  { value: 'recent', label: 'Recently active' },
  { value: 'name', label: 'Name' },
  { value: 'members', label: 'Members' },
]

/** Search, filter, and sort applied in that order. Pure — safe inside useMemo. */
export function selectRooms(rooms, { query = '', filter = 'all', sort = 'recent' } = {}) {
  const needle = query.trim().toLowerCase()

  const matched = rooms.filter((room) => {
    if (filter === 'live' && !isRoomLive(room)) return false
    if (filter === 'public' && !room.isPublic) return false
    if (filter === 'private' && room.isPublic) return false
    if (!needle) return true
    return (
      String(room.name || '').toLowerCase().includes(needle) ||
      String(room.roomId || '').toLowerCase().includes(needle)
    )
  })

  const time = (room) => (room.lastActivityAt ? new Date(room.lastActivityAt).getTime() : 0)

  return [...matched].sort((a, b) => {
    if (sort === 'name') return roomLabel(a).localeCompare(roomLabel(b))
    if (sort === 'members') return (b.memberCount || 0) - (a.memberCount || 0)
    return time(b) - time(a)
  })
}
