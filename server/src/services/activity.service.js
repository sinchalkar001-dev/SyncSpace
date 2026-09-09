import { Activity, ACTIVITY, ACTIVITY_KINDS } from '../models/Activity.js'
import { logger } from '../config/logger.js'

/**
 * Recording what happened in a room, and reading it back.
 *
 * The hard requirement on the write side is that it must never matter. These
 * calls sit in the middle of a Yjs transaction, a socket handler and the tail
 * of a program run — three paths where an await that rejects, or merely one
 * that is slow, is a worse outcome than losing the row. So every write here is
 * fire-and-forget and swallows its own failures, and no caller is given a
 * promise it might be tempted to await.
 */

export { ACTIVITY }

/**
 * Continuous typing is one event, not four hundred.
 *
 * A Yjs document emits a transaction per keystroke batch, so recording edits
 * naively would write more rows per minute than the room has characters, and
 * the feed would say "Jishu edited the code" two hundred times in a row. The
 * throttle is in memory rather than a database upsert because the whole point
 * is to not touch the database: the check has to be cheaper than the write it
 * is avoiding.
 *
 * Per-process, which means two servers can each write one row for the same
 * burst. That is the right trade — the alternative is a shared counter on the
 * hot path of every edit, to deduplicate rows in a panel nobody is reading
 * transactionally.
 */
const WINDOW_MS = 60 * 1000

/** key -> timestamp of the last row written for it. */
const lastWritten = new Map()

/**
 * Bounded so a long-lived process with many rooms cannot grow it without end.
 * Well above any plausible number of simultaneously-edited rooms, so the sweep
 * is rare; when it does run it drops everything already outside its window,
 * which is exactly the set that can no longer suppress anything.
 */
const MAX_KEYS = 5000

function throttled(key, now) {
  const previous = lastWritten.get(key)
  if (previous !== undefined && now - previous < WINDOW_MS) return true

  if (lastWritten.size >= MAX_KEYS) {
    for (const [candidate, at] of lastWritten) {
      if (now - at >= WINDOW_MS) lastWritten.delete(candidate)
    }
  }

  lastWritten.set(key, now)
  return false
}

/** Only for tests, which must not inherit a window from the test before. */
export function resetActivityThrottle() {
  lastWritten.clear()
}

const trim = (value, max) => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text ? text.slice(0, max) : null
}

/**
 * Writes one event, unless an identical one was just written.
 *
 * `collapse` opts a kind into the throttle. Edits want it — they arrive
 * continuously and mean one thing. A finished program run does not: two runs a
 * second apart are two results, and collapsing them would hide the one that
 * failed.
 *
 * Returns nothing on purpose. Callers are hot paths, and a returned promise is
 * an invitation to await one.
 */
export function recordActivity({ roomId, kind, actor = null, actorName = null, detail = null, collapse = false }) {
  if (!roomId || !ACTIVITY_KINDS.includes(kind)) return

  const name = trim(actorName, 64)

  if (collapse && throttled(roomId + ':' + kind + ':' + (actor ?? name ?? '?'), Date.now())) {
    return
  }

  Activity.create({
    roomId,
    kind,
    actor: actor ?? null,
    actorName: name,
    detail: trim(detail, 120),
    at: new Date(),
  }).catch((error) => {
    // Debug rather than error: this is a panel on a dashboard, and a room that
    // works perfectly while its feed is missing a line is not an incident.
    logger.debug({ err: error, room: roomId, kind }, 'activity not recorded')
  })
}

const LIMIT = { default: 20, max: 100 }

function limitOf(value) {
  const asked = Number.parseInt(value, 10)
  if (!Number.isFinite(asked) || asked < 1) return LIMIT.default
  return Math.min(asked, LIMIT.max)
}

/** One room's feed, newest first. */
export async function listRoomActivity(roomId, { limit } = {}) {
  const rows = await Activity.find({ roomId }).sort({ at: -1 }).limit(limitOf(limit))
  return rows.map((row) => row.toPublic())
}

/**
 * The feed across a set of rooms, newest first.
 *
 * Takes the room ids rather than a user, so the caller stays responsible for
 * deciding which rooms this person may see. An activity feed is exactly the
 * kind of endpoint that leaks a private room's existence if it works out
 * access for itself and gets it slightly wrong.
 */
export async function listActivityForRooms(roomIds, { limit } = {}) {
  if (!roomIds?.length) return []

  const rows = await Activity.find({ roomId: { $in: roomIds } })
    .sort({ at: -1 })
    .limit(limitOf(limit))

  return rows.map((row) => row.toPublic())
}
