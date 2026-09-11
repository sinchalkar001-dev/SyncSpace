/**
 * What the session panel needs to know that is not React.
 *
 * Summaries and explanations arrive as statements that cite events by id, and
 * the panel's whole job is to keep every statement one click from the evidence
 * behind it. These are the pieces that make that work: finding the events a
 * statement cites, and turning an event's log position into a place on the
 * replay scrubber.
 */

/** The summary's sections, in the order a person reads a session. */
export const SECTION_LABELS = Object.freeze([
  { key: 'decisions', label: 'Major decisions' },
  { key: 'architecture', label: 'Architecture changes' },
  { key: 'code', label: 'Code changes' },
  { key: 'failed', label: 'Failed approaches' },
  { key: 'succeeded', label: 'What worked' },
  { key: 'unresolved', label: 'Unresolved problems' },
  { key: 'collaboration', label: 'Collaboration' },
])

const ICONS = [
  ['architecture.', 'layers'],
  ['code.', 'code'],
  ['execution.failed', 'alert'],
  ['execution.cancelled', 'close'],
  ['execution.succeeded', 'checkCircle'],
  ['people.', 'users'],
  ['ai.', 'zap'],
  ['board.', 'pen'],
  ['comment.', 'comment'],
  ['state.warning', 'alert'],
  ['moment.', 'clock'],
]

export function iconForKind(kind) {
  const found = ICONS.find(([prefix]) => String(kind ?? '').startsWith(prefix))
  return found ? found[1] : 'activity'
}

/**
 * How an event reads in a list.
 *
 * People and comment events are verbs that need their subject — "joined the
 * room" or "commented on line 12" alone says nothing — so the actor leads.
 * Everything else is already a sentence about the work, with the actor as a
 * quiet attribution.
 */
const LED_BY_ACTOR = ['people.', 'comment.']

export function describeEvent(event) {
  if (!event) return { text: '', by: null }
  if (LED_BY_ACTOR.some((prefix) => String(event.kind).startsWith(prefix))) {
    return { text: (event.actor || 'Somebody') + ' ' + event.text, by: null }
  }
  return { text: event.text, by: event.actor || null }
}

/**
 * The events a statement cites, resolved from the copy the answer carries.
 *
 * Looked up in the answer's own `cited` map rather than the live timeline: a
 * summary written an hour ago must still show the events it was built on,
 * even if the timeline has grown or shifted since.
 */
export function citationsOf(statement, cited) {
  if (!statement?.events?.length || !cited) return []
  return statement.events
    .map((id) => (cited[id] ? { id, ...cited[id] } : null))
    .filter(Boolean)
}

/**
 * The scrubber position showing the document as it stood at `seq`.
 *
 * Position N shows the state after the Nth logged change, so this is one past
 * the last entry at or before `seq`. Binary search, because a long history has
 * thousands of entries and this runs on every citation click.
 */
export function indexForSeq(entries, seq) {
  if (!entries?.length || !Number.isFinite(seq) || seq <= 0) return 0

  let low = 0
  let high = entries.length - 1
  let found = -1

  while (low <= high) {
    const mid = (low + high) >> 1
    if (entries[mid].seq <= seq) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return found + 1
}

/** The newest event at or before the replay's position, to mark as current. */
export function currentEventId(events, seq) {
  if (!events?.length || !Number.isFinite(seq)) return null
  let current = null
  for (const event of events) {
    if (event.seq <= seq) current = event.id
    else break
  }
  return current
}

/** Whether a summary section has anything to show. */
export const hasStatements = (sections, key) => Array.isArray(sections?.[key]) && sections[key].length > 0
