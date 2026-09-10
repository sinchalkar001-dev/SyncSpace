/**
 * What a collaborator is doing, how often that is allowed to be said, and how
 * it reads.
 *
 * Presence rides on Yjs awareness, which is a separate channel from the
 * document: Hocuspocus applies awareness messages to `document.awareness` and
 * never to the document itself, so nothing in here can reach the update log,
 * a snapshot, replay, or the activity feed. That separation is structural, not
 * a promise this file keeps — there is a server test that holds it to it.
 *
 * Awareness has one property that shapes everything below: every change to any
 * field re-sends the client's *whole* state to everybody in the room. So the
 * rules are to keep that state small, to send nothing that has not changed, and
 * to split what changes often (a pointer) from what changes rarely (what you
 * are doing), so the rare thing is not re-sent at the rate of the frequent one.
 */

export const PRESENCE_VERSION = 1

/**
 * The most often each kind of presence may leave this machine.
 *
 * The cursor used to go out every 40ms (25 a second). It now goes out every
 * 66ms (about 15) and the receiving side eases between samples, which looks
 * smoother than 25 raw positions ever did — a cursor that jumps to each sample
 * is jerky at any rate, and one that glides is smooth at nearly any rate.
 */
export const RATES = Object.freeze({
  cursorMs: 66,
  presenceMs: 250,
  viewMs: 120,
})

/** An edit or a stroke keeps you "editing" or "drawing" this long afterwards. */
export const ACTIVE_MS = 4000

/** No input at all for this long and you read as idle. */
export const IDLE_MS = 60000

/** Enough to outline a selection; a marquee of three hundred is not news. */
export const MAX_SELECTED = 12

/**
 * The file the room's buffer is, in each language.
 *
 * There is one shared buffer rather than a tree of files, so "current file" is
 * the name that buffer has when it runs — the same name the runner writes it
 * to — rather than something invented to look like an IDE.
 */
const FILE_NAMES = Object.freeze({
  javascript: 'main.js',
  typescript: 'main.ts',
  python: 'main.py',
  java: 'Main.java',
  cpp: 'main.cpp',
  go: 'main.go',
  rust: 'main.rs',
})

export const fileNameFor = (language) => FILE_NAMES[language] ?? 'main.txt'

/**
 * What somebody is doing right now, from what they last did.
 *
 * Clamped by permission on purpose. A viewer can have the editor focused and
 * type into it all day — the connection is read-only and nothing they press
 * reaches anybody — so reporting them as "editing" would be telling the room
 * something false. They read as viewing, which is what they are doing.
 */
export function activityOf({
  surface,
  lastTypedAt = 0,
  lastDrewAt = 0,
  lastInputAt = 0,
  selectedCount = 0,
  canEditCode = true,
  canEditBoard = true,
  hidden = false,
  now = Date.now(),
}) {
  if (hidden) return 'away'
  if (now - lastInputAt > IDLE_MS) return 'idle'

  if (surface === 'code') {
    return canEditCode && now - lastTypedAt < ACTIVE_MS ? 'editing' : 'reading'
  }

  if (surface === 'board') {
    if (canEditBoard && now - lastDrewAt < ACTIVE_MS) return 'drawing'
    if (canEditBoard && selectedCount > 0) return 'selecting'
    return 'browsing'
  }

  return 'present'
}

/**
 * The presence field as it goes over the wire.
 *
 * Keys in a fixed order so `JSON.stringify` of two equal states is the same
 * string — that string is how "has anything changed" is answered without a
 * deep compare on every keystroke.
 *
 * When sharing is off, the location never leaves the machine at all: no line,
 * no surface, no file, no selection, and an activity coarsened to "here" or
 * "away". Hiding it on the receiving end instead would mean trusting every
 * other client to look away.
 */
export function buildPresence({
  activity = 'present',
  surface = null,
  line = null,
  file = null,
  selected = null,
  sharing = true,
  following = null,
}) {
  if (!sharing) {
    return {
      v: PRESENCE_VERSION,
      activity: activity === 'away' ? 'away' : 'present',
      surface: null,
      file: null,
      line: null,
      selected: null,
      share: false,
      following: following ?? null,
    }
  }

  return {
    v: PRESENCE_VERSION,
    activity,
    surface: surface ?? null,
    file: surface === 'code' ? file ?? null : null,
    line: surface === 'code' && Number.isInteger(line) ? line : null,
    selected: selected?.length ? selected.slice(0, MAX_SELECTED) : null,
    share: true,
    following: following ?? null,
  }
}

const count = (n, noun) => n + ' ' + noun + (n === 1 ? '' : 's')

/**
 * How a collaborator's presence reads, as a status and an optional place.
 *
 *   Editing Main.java    Line 42
 *   Drawing              Whiteboard
 *
 * A client from before this existed sends no presence field, and reads as
 * plainly online rather than as broken.
 */
export function describePresence(presence) {
  if (!presence || presence.v !== PRESENCE_VERSION) {
    return { tone: 'active', status: 'Online', place: null }
  }

  if (presence.activity === 'away') return { tone: 'away', status: 'Away', place: null }

  if (!presence.share) {
    return { tone: 'active', status: 'Online', place: 'Not sharing activity' }
  }

  const file = presence.file || 'the code'
  const line = presence.line != null ? 'Line ' + presence.line : null

  switch (presence.activity) {
    case 'idle':
      return { tone: 'idle', status: 'Idle', place: line }
    case 'editing':
      return { tone: 'active', status: 'Editing ' + file, place: line }
    case 'reading':
      return { tone: 'active', status: 'Viewing ' + file, place: line }
    case 'drawing':
      return { tone: 'active', status: 'Drawing', place: 'Whiteboard' }
    case 'selecting':
      return {
        tone: 'active',
        status: 'Selecting',
        place: count(presence.selected?.length ?? 0, 'object') + ' on the whiteboard',
      }
    case 'browsing':
      return { tone: 'active', status: 'On the whiteboard', place: null }
    default:
      return { tone: 'active', status: 'Online', place: null }
  }
}

/** Following needs somebody to follow: a live, sharing, current client. */
export const canFollow = (peer) =>
  Boolean(peer?.user && peer.presence?.v === PRESENCE_VERSION && peer.presence.share)

/**
 * Focusing is a one-off jump, so it needs only a place to jump to. An older
 * client with a cursor but no presence still has one.
 */
export const canFocus = (peer) =>
  Boolean(peer?.user) &&
  (peer.presence ? peer.presence.share === true : Boolean(peer.cursor))

/* ---------- the board's point of view ---------- */

/**
 * The centre of what somebody is looking at, in board coordinates.
 *
 * Centre and scale rather than the raw stage offset, because two people's
 * screens are different sizes: the same offset on a laptop and on a monitor
 * frames two different parts of the board. The centre is the same place on
 * both.
 */
export function viewCenter(viewport, size) {
  const scale = viewport?.scale || 1
  return {
    cx: Math.round(((size?.width || 0) / 2 - (viewport?.x || 0)) / scale),
    cy: Math.round(((size?.height || 0) / 2 - (viewport?.y || 0)) / scale),
    scale: Math.round(scale * 1000) / 1000,
  }
}

/** The stage offset that puts board point (cx, cy) in the middle of `size`. */
export function centerOn({ cx, cy, scale = 1 }, size) {
  return {
    scale,
    x: (size?.width || 0) / 2 - cx * scale,
    y: (size?.height || 0) / 2 - cy * scale,
  }
}

export const viewKey = (view) => (view ? view.cx + ':' + view.cy + ':' + view.scale : 'none')

/* ---------- smoothing a cursor between samples ---------- */

/**
 * A remote cursor that has to cross this much of the board is teleporting, not
 * moving — somebody panned, or came back after a while — and gliding across the
 * whole canvas to get there reads as lag rather than smoothness.
 */
export const SNAP_DISTANCE = 1200

/** How quickly a cursor closes on where it has been told to be. */
const EASE_MS = 70

/** Within this, a cursor has arrived and the frame loop can stop. */
const SETTLED = 0.5

/**
 * One frame of movement toward a target.
 *
 * Exponential rather than linear, and scaled by elapsed time rather than per
 * frame, so the cursor behaves the same on a 144Hz monitor as on a throttled
 * background tab: it covers the same share of the remaining distance in the
 * same wall-clock time, however many frames that turns out to be.
 */
export function stepCursor(current, target, dtMs) {
  if (!current) return { x: target.x, y: target.y, settled: true }

  const dx = target.x - current.x
  const dy = target.y - current.y
  const distance = Math.hypot(dx, dy)

  if (distance > SNAP_DISTANCE || distance < SETTLED) {
    return { x: target.x, y: target.y, settled: true }
  }

  const k = 1 - Math.exp(-Math.max(0, dtMs) / EASE_MS)
  return { x: current.x + dx * k, y: current.y + dy * k, settled: false }
}

/* ---------- telling the panes where to look ---------- */

/**
 * A small bus between presence and the two panes.
 *
 * Following and focusing both end in "scroll the editor to line 42" or "move
 * the board to here", and only the panes know how. Rather than threading an
 * editor instance and a stage size up to the room, each pane listens for its
 * own surface and does the moving itself.
 */
export function createNavigator() {
  const listeners = new Map()

  return {
    on(surface, fn) {
      if (!listeners.has(surface)) listeners.set(surface, new Set())
      listeners.get(surface).add(fn)
      return () => listeners.get(surface)?.delete(fn)
    },
    emit(surface, payload) {
      listeners.get(surface)?.forEach((fn) => fn(payload))
    },
  }
}
