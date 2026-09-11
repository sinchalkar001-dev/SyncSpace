import * as Y from 'yjs'
import { shapeBounds } from './hitTest.js'

/**
 * Where comments point, and how to find those places again.
 *
 * A comment is stored with an anchor, and the anchor is only useful if it can
 * be turned back into a place on screen after everything around it has moved:
 * lines inserted above a commented line, a commented shape dragged across the
 * board, a file renamed. Each kind of anchor is built to survive the kind of
 * change its target goes through.
 *
 * Code anchors are Yjs relative positions. A line number goes stale the moment
 * somebody types above it; a relative position is attached to the characters
 * themselves, so it follows them through everybody's edits. They are computed
 * from the document every client already holds, so anchoring a comment writes
 * nothing to it — no Yjs traffic, and nothing added to the room's history.
 */

/* ---------- bytes ---------- */

export function toBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export function fromBase64(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/* ---------- lines ---------- */

/** Offsets where each line begins, so a line lookup is a binary search. */
export function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

/** 1-based line of a character offset. */
export function lineAt(starts, index) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= index) low = mid
    else high = mid - 1
  }
  return low + 1
}

/** Character offset of a 1-based line and column, clamped to the text. */
export function offsetAt(starts, text, line, column) {
  const row = Math.min(Math.max(1, line), starts.length)
  const start = starts[row - 1]
  const end = row < starts.length ? starts[row] - 1 : text.length
  return Math.min(start + Math.max(0, column - 1), end)
}

/* ---------- code ---------- */

const SNIPPET = 280

/**
 * An anchor for a range of the room's code.
 *
 * `range` is Monaco's shape — 1-based lines and columns. An empty range is a
 * comment on the whole line, which is what somebody clicking in a line without
 * selecting anything means.
 *
 * The start attaches to the character after it and the end to the character
 * before it, so typing just outside the range does not pull it in, while
 * editing inside it keeps the comment with the code it was about.
 */
export function codeAnchor(yText, range) {
  const text = yText.toString()
  const starts = lineStarts(text)

  let a = offsetAt(starts, text, range.startLineNumber, range.startColumn)
  let b = offsetAt(starts, text, range.endLineNumber, range.endColumn)
  if (a > b) [a, b] = [b, a]

  if (a === b) {
    const row = lineAt(starts, a)
    a = starts[row - 1]
    b = row < starts.length ? starts[row] - 1 : text.length
  }

  const startLine = lineAt(starts, a)
  const endLine = lineAt(starts, b)
  const encode = (index, assoc) =>
    toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(yText, index, assoc)))

  return {
    kind: 'code',
    start: encode(a, 0),
    end: encode(b, -1),
    line: startLine,
    endLine,
    startColumn: a - starts[startLine - 1] + 1,
    endColumn: b - starts[endLine - 1] + 1,
    snippet: text.slice(a, b).slice(0, SNIPPET) || null,
  }
}

/**
 * Where every code anchor points now, reading the text once for all of them.
 *
 * Resolving each anchor on its own would scan the whole buffer per comment;
 * with a hundred comments on a long file that is a hundred scans per edit.
 * Here the text is read and its lines indexed once, and each anchor costs a
 * relative-position lookup and a binary search.
 *
 * A range whose characters have all been deleted collapses to a point. That is
 * reported as `orphaned` rather than silently shown on whatever line is left
 * there — the comment is about code that no longer exists.
 */
export function resolveCodeAnchors(threads, yText) {
  const doc = yText?.doc
  const result = new Map()
  if (!doc) return result

  const text = yText.toString()
  const starts = lineStarts(text)

  for (const thread of threads) {
    const anchor = thread.anchor
    if (anchor?.kind !== 'code' || !anchor.start || !anchor.end) continue

    try {
      const start = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(fromBase64(anchor.start)),
        doc
      )
      const end = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(fromBase64(anchor.end)),
        doc
      )
      if (!start || !end || start.type !== yText || end.type !== yText) continue

      const from = start.index
      const to = Math.max(from, end.index)

      result.set(thread.id, {
        line: lineAt(starts, from),
        endLine: lineAt(starts, to),
        from,
        to,
        orphaned: to === from && Boolean(anchor.snippet),
      })
    } catch {
      // A position from a document this client has not seen yet; it will
      // resolve on the next pass once the update arrives.
    }
  }

  return result
}

/* ---------- the board ---------- */

/** A name for a shape, for labels and for the history. */
export function shapeLabel(shape) {
  if (!shape) return null
  if (shape.type === 'text' && shape.text) return String(shape.text).slice(0, 120)
  const names = {
    rect: 'Rectangle',
    diamond: 'Diamond',
    ellipse: 'Ellipse',
    line: 'Stroke',
    segment: 'Line',
    arrow: 'Arrow',
    text: 'Text',
  }
  return names[shape.type] ?? 'Shape'
}

const clampUnit = (value) => Math.min(1, Math.max(0, value))

/**
 * An anchor on a shape, at the point on it that was clicked.
 *
 * Stored as a fraction of the shape's bounds rather than a board position, so
 * the pin rides along when the shape is dragged or resized. The board position
 * is kept too, as where to show the comment if the shape is later deleted.
 */
export function shapeAnchor(shape, point) {
  const bounds = shapeBounds(shape)
  const fraction = (value, origin, size) => (size > 0 ? clampUnit((value - origin) / size) : 0.5)

  return {
    kind: 'shape',
    shapeId: shape.id,
    offsetX: bounds ? fraction(point.x, bounds.x, bounds.width) : 0.5,
    offsetY: bounds ? fraction(point.y, bounds.y, bounds.height) : 0.5,
    x: Math.round(point.x),
    y: Math.round(point.y),
    label: shapeLabel(shape),
  }
}

/** An anchor on the board itself: a point, or a dragged rectangle. */
export function regionAnchor(from, to = from) {
  return {
    kind: 'region',
    x: Math.round(Math.min(from.x, to.x)),
    y: Math.round(Math.min(from.y, to.y)),
    width: Math.round(Math.abs(to.x - from.x)),
    height: Math.round(Math.abs(to.y - from.y)),
  }
}

/**
 * Where a board anchor is now.
 *
 * A shape anchor follows its shape; if the shape has gone it stays where the
 * shape last was and says so, rather than vanishing along with it.
 */
export function resolveBoardAnchor(anchor, shapesById) {
  if (anchor?.kind === 'region') {
    return { x: anchor.x, y: anchor.y, width: anchor.width || 0, height: anchor.height || 0, detached: false }
  }

  if (anchor?.kind === 'shape') {
    const bounds = shapeBounds(shapesById.get(anchor.shapeId))
    if (bounds) {
      return {
        x: bounds.x + (anchor.offsetX ?? 0.5) * bounds.width,
        y: bounds.y + (anchor.offsetY ?? 0.5) * bounds.height,
        width: 0,
        height: 0,
        detached: false,
      }
    }
    if (Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
      return { x: anchor.x, y: anchor.y, width: 0, height: 0, detached: true }
    }
  }

  return null
}

/* ---------- saying where ---------- */

/** "Line 12", "Lines 12–14", "Database", "spec.pdf", "Whiteboard". */
export function anchorLabel(anchor, resolvedCode = null) {
  if (!anchor) return 'Room'
  switch (anchor.kind) {
    case 'code': {
      const line = resolvedCode?.line ?? anchor.line
      const endLine = resolvedCode?.endLine ?? anchor.endLine ?? line
      return endLine > line ? 'Lines ' + line + '–' + endLine : 'Line ' + line
    }
    case 'shape':
      return anchor.label || 'Shape'
    case 'file':
      return anchor.label || 'File'
    default:
      return anchor.width || anchor.height ? 'Whiteboard area' : 'Whiteboard'
  }
}

export const anchorIcon = (anchor) =>
  ({ code: 'code', shape: 'rect', region: 'pen', file: 'inbox' })[anchor?.kind] ?? 'inbox'

/* ---------- threads ---------- */

/** A thread every message of which has been deleted is gone, as far as the room is concerned. */
export const isVisible = (thread) => thread.messages?.some((message) => !message.deleted)

/**
 * Open first, then newest activity first. Resolved threads are kept, below,
 * because "was this ever discussed?" is a question people ask.
 */
export function sortThreads(threads) {
  return [...threads].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1
    return new Date(b.updatedAt) - new Date(a.updatedAt)
  })
}

/**
 * Merges a thread into a list, keeping whichever copy is newer.
 *
 * Announcements and responses race: the socket can deliver the room's copy of
 * a change before the request that made it has answered, or after. Version
 * numbers decide, so a stale copy arriving late never rolls a thread back.
 */
export function mergeThread(threads, incoming) {
  const index = threads.findIndex((thread) => thread.id === incoming.id)
  if (index === -1) return [incoming, ...threads]
  if ((threads[index].version ?? 0) > (incoming.version ?? 0)) return threads
  const next = threads.slice()
  next[index] = incoming
  return next
}

/**
 * What is new for this person since they last looked.
 *
 * Messages by somebody else, newer than their read marker. Mentions of them
 * are counted separately because they are the thing worth interrupting for.
 */
export function unreadOf(threads, { userId, seenAt }) {
  const since = seenAt ? new Date(seenAt).getTime() : 0
  let count = 0
  let mentions = 0

  for (const thread of threads) {
    for (const message of thread.messages ?? []) {
      if (message.deleted || message.author === userId) continue
      if (new Date(message.createdAt).getTime() <= since) continue
      count += 1
      if (userId && message.mentions?.includes(userId)) mentions += 1
    }
  }

  return { count, mentions }
}

/* ---------- mentions ---------- */

/**
 * The mention being typed at the caret, if there is one: an @ at the start of
 * a word, followed by what has been typed of the name so far.
 */
export function mentionQuery(text, caret) {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query) || query.length > 32) return null
  return { start: at, query }
}

/** The text with the typed mention replaced by the chosen name. */
export function insertMention(text, start, caret, name) {
  const insert = '@' + name + ' '
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length }
}

/**
 * The people a message still mentions when it is sent.
 *
 * Somebody picked from the list and then deleted from the text is no longer
 * mentioned — the text is what the author sees, so it is what counts.
 */
export function mentionsIn(text, picked) {
  return picked.filter((person) => text.includes('@' + person.name)).map((person) => person.id)
}

/**
 * A message split into text and mentions, for rendering.
 *
 * Only the names of people the message actually mentions are highlighted; an
 * @ followed by some other word is just text.
 */
export function mentionSegments(body, names) {
  const wanted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!wanted.length) return [{ text: body, mention: false }]

  const segments = []
  let cursor = 0
  while (cursor < body.length) {
    let found = -1
    let name = null
    for (const candidate of wanted) {
      const index = body.indexOf('@' + candidate, cursor)
      if (index !== -1 && (found === -1 || index < found)) {
        found = index
        name = candidate
      }
    }
    if (found === -1) {
      segments.push({ text: body.slice(cursor), mention: false })
      break
    }
    if (found > cursor) segments.push({ text: body.slice(cursor, found), mention: false })
    segments.push({ text: '@' + name, mention: true })
    cursor = found + name.length + 1
  }
  return segments
}

/* ---------- replay ---------- */

/**
 * A thread as it stood at a point in the room's history, or null if it did
 * not exist yet.
 *
 * Every event carries the position the update log had reached when it
 * happened, so a replay at position N shows exactly the threads opened by
 * then, resolved or open as they were then, with the messages written by then.
 * A message deleted later is still shown at the points where it existed.
 */
export function threadAt(thread, seq) {
  if ((thread.createdSeq ?? 0) > seq) return null

  let status = 'open'
  const written = new Set()
  const removed = new Set()

  for (const event of thread.events ?? []) {
    if ((event.seq ?? 0) > seq) continue
    if (event.type === 'resolved') status = 'resolved'
    if (event.type === 'reopened') status = 'open'
    if ((event.type === 'opened' || event.type === 'replied') && event.messageId) written.add(event.messageId)
    if (event.type === 'deleted' && event.messageId) removed.add(event.messageId)
  }

  const messages = (thread.messages ?? []).filter(
    (message) => written.has(message.id) && !removed.has(message.id)
  )

  return messages.length ? { ...thread, status, messages } : null
}
