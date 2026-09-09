/**
 * Room helpers shared by the dashboard, the room card, and the people dialog.
 *
 * Everything the dashboard shows is derived from the one `/api/rooms` payload
 * it already fetches — the rooms, who is in them, and what this person has
 * pinned or archived all arrive together, so no amount of searching, filtering
 * or sorting costs a request. That is what keeps the page usable at forty
 * rooms and not only at four.
 *
 * These functions are pure so they can live inside `useMemo` without lying
 * about their dependencies.
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

/**
 * What a room is for.
 *
 * A fixed set rather than free tags, and the same four the server enforces.
 * `general` is what an unclassified room is, not a rubbish bin — which is why
 * it reads "General" on a card rather than "Other".
 */
export const ROOM_KINDS = Object.freeze([
  { value: 'general', label: 'General', icon: 'grid' },
  { value: 'coding', label: 'Coding', icon: 'code' },
  { value: 'interview', label: 'Interview', icon: 'users' },
  { value: 'system-design', label: 'System design', icon: 'layers' },
])

const KIND_BY_VALUE = new Map(ROOM_KINDS.map((kind) => [kind.value, kind]))

/** Falls back rather than rendering a blank badge for a value we do not know. */
export const kindOf = (room) => KIND_BY_VALUE.get(room?.kind) ?? KIND_BY_VALUE.get('general')

/** True when this account owns the room, rather than having been let into it. */
export const isMine = (room, userId) => Boolean(userId && room?.owner && room.owner === userId)

export const isShared = (room, userId) => Boolean(userId && room?.owner && room.owner !== userId)

/**
 * The type filter, with a count against each so an empty option is visibly
 * empty before it is chosen rather than after.
 */
export function kindFilters(rooms) {
  return [
    { value: 'all', label: 'All', count: rooms.length },
    ...ROOM_KINDS.map((kind) => ({
      value: kind.value,
      label: kind.label,
      icon: kind.icon,
      count: rooms.filter((room) => kindOf(room).value === kind.value).length,
    })),
  ]
}

export const SORTS = Object.freeze([
  { value: 'recent', label: 'Recent activity' },
  { value: 'updated', label: 'Recently changed' },
  { value: 'name', label: 'Name' },
  { value: 'collaborators', label: 'Collaborators' },
])

const timeOf = (value) => (value ? new Date(value).getTime() : 0)

/**
 * Search, filter and sort, applied in that order.
 *
 * Archived rooms are excluded unless asked for, and pinning deliberately does
 * *not* reorder anything here: pinned rooms are lifted into their own section
 * by `partitionRooms`, and having them also float to the top of the main grid
 * would show the same room twice.
 */
export function selectRooms(
  rooms,
  { query = '', kind = 'all', sort = 'recent', archived = false, userId = null, owner = 'all' } = {}
) {
  const needle = query.trim().toLowerCase()

  const matched = rooms.filter((room) => {
    if (Boolean(room.archived) !== archived) return false
    if (kind !== 'all' && kindOf(room).value !== kind) return false
    if (owner === 'mine' && !isMine(room, userId)) return false
    if (owner === 'shared' && !isShared(room, userId)) return false
    if (!needle) return true

    return (
      String(room.name || '').toLowerCase().includes(needle) ||
      String(room.roomId || '').toLowerCase().includes(needle) ||
      String(room.description || '').toLowerCase().includes(needle) ||
      (room.collaborators ?? []).some((person) =>
        String(person.name || '').toLowerCase().includes(needle)
      )
    )
  })

  return [...matched].sort((a, b) => {
    if (sort === 'name') return roomLabel(a).localeCompare(roomLabel(b))
    if (sort === 'collaborators') return (b.memberCount || 0) - (a.memberCount || 0)
    if (sort === 'updated') return timeOf(b.updatedAt) - timeOf(a.updatedAt)
    return timeOf(b.lastActivityAt) - timeOf(a.lastActivityAt)
  })
}

/**
 * Splits an already-selected list into the pinned ones and the rest.
 *
 * Pinned rooms keep the order the person pinned them in — most recent first —
 * rather than the sort chosen for the grid. A hand-built list that silently
 * rearranges itself when you change a dropdown is not a hand-built list.
 */
export function partitionRooms(rooms) {
  const pinned = rooms
    .filter((room) => room.pinned)
    .sort((a, b) => timeOf(b.pinnedAt) - timeOf(a.pinnedAt))

  return { pinned, rest: rooms.filter((room) => !room.pinned) }
}

/**
 * The room to offer to go back to.
 *
 * The most recently active room that has not been archived, which is as close
 * as this data gets to "where you left off" — the server records when a room
 * was last touched, not who touched it, so a room a colleague was in overnight
 * can win. That is still the right room to offer: it is the one with something
 * new in it.
 *
 * Nothing is offered when the most recent room has been quiet for a week. A
 * "continue" button pointing at something a fortnight old is not continuing.
 */
const STALE_MS = 7 * DAY_MS

export function continueRoom(rooms, now = Date.now()) {
  const candidate = rooms
    .filter((room) => !room.archived && room.lastActivityAt)
    .sort((a, b) => timeOf(b.lastActivityAt) - timeOf(a.lastActivityAt))[0]

  if (!candidate) return null
  return now - timeOf(candidate.lastActivityAt) > STALE_MS ? null : candidate
}

/** The figures in the header. Counted over everything, not the filtered view. */
export function summarise(rooms, userId = null) {
  const live = rooms.filter((room) => !room.archived && isRoomLive(room))

  return {
    total: rooms.filter((room) => !room.archived).length,
    live: live.length,
    shared: rooms.filter((room) => !room.archived && isShared(room, userId)).length,
    pinned: rooms.filter((room) => room.pinned && !room.archived).length,
    archived: rooms.filter((room) => room.archived).length,
  }
}

/**
 * Rooms bucketed by day of last activity, oldest first, for the sparkline.
 * A room only ever lands in one bucket — this is "when was each room last
 * touched", not a full activity history.
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
