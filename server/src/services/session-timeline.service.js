import * as Y from 'yjs'
import mongoose from 'mongoose'
import { DocUpdate } from '../models/DocUpdate.js'
import { Execution } from '../models/Execution.js'
import { Activity, ACTIVITY } from '../models/Activity.js'
import { Generation } from '../models/Generation.js'
import { User } from '../models/User.js'
import { extractArchitecture } from './architecture.service.js'
import { stateAt } from './replay.service.js'
import { toUint8 } from '../utils/binary.js'

/**
 * A room's history as a list of things that happened, with no model involved.
 *
 * The update log records every keystroke as an opaque Yjs update, which is
 * exactly right for replaying a room and useless for describing one — "update
 * 1,842 was 23 bytes" says nothing about what anybody built. This turns the
 * log into events a person would recognise: a component appearing on the
 * board, functions arriving in the code, a run failing and then passing.
 *
 * Every event is derived from something recorded, never inferred:
 *
 *   architecture   the whiteboard's components and connections, read with the
 *                  same parser the code generator uses, diffed between points
 *   code           declared functions and classes, and lines added or removed
 *   runs           the execution records, with how each one ended
 *   people         joins and conversations from the activity feed
 *   AI             proposals generated from the board, and what was applied
 *
 * This is the only thing the summaries are allowed to talk about. A model given
 * this list, and made to cite an event for every statement, has nothing to
 * invent from.
 *
 * It is also deliberately separate from replay. Nothing here runs on the path
 * that serves frames; it is built only when somebody opens the session panel,
 * walks the log in one streaming pass, gives the event loop back every few
 * hundred entries so it cannot stall anybody else's replay, and is cached
 * against everything it was built from.
 */

/** A pause this long, or a change of author, starts a new piece of work. */
export const SEGMENT_GAP_MS = 45_000

/** Even continuous typing is split this often, so a long burst still has steps. */
const SEGMENT_MAX_ENTRIES = 400

/**
 * How much of the log one timeline will walk. A room past this is described up
 * to here and says so, rather than holding a request open for a minute.
 */
export const MAX_LOG_ENTRIES = 20_000

/** How many events one timeline will hand to a person or a model. */
export const MAX_EVENTS = 250

const YIELD_EVERY = 500
const CACHE_LIMIT = 50
const MAX_RUNS = 300
const MAX_TEXT = 160

const cache = new Map()

/** Tests only: a fresh process has no timelines in memory. */
export function resetTimelineCache() {
  cache.clear()
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve))

const clamp = (value, max = MAX_TEXT) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** "00:04", "12:31", "1:02:09" — elapsed time since the session began. */
export function clockOf(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return hours > 0 ? hours + ':' + pad(minutes) + ':' + pad(seconds) : pad(minutes) + ':' + pad(seconds)
}

/* ---------- reading code ---------- */

/**
 * Names a file declares, across the languages the editor offers.
 *
 * Deliberately conservative. A missed declaration costs a less specific event
 * ("code edited, +12 lines"); a false one puts a function in the summary that
 * nobody wrote. So only shapes that cannot be anything else are matched:
 * keyword declarations, arrow functions assigned to a name, and methods with
 * at least one access modifier — never a bare `name(`, which is also a call.
 */
const DECLARATION = /\b(?:function|def|func|fn|class|interface|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g
const ARROW = /\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*=>/g
const METHOD = /^[ \t]*(?:(?:public|private|protected|static|final|async|override|virtual)\s+)+[A-Za-z_][\w<>[\],.]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm

export function declarationsIn(code) {
  const names = new Set()
  for (const pattern of [DECLARATION, ARROW, METHOD]) {
    for (const match of String(code ?? '').matchAll(pattern)) names.add(match[1])
  }
  return names
}

/**
 * Lines added and removed, counted as a multiset rather than aligned.
 *
 * A real diff would say where; this only needs to say how much, and a
 * multiset count is linear where alignment is quadratic in the worst case —
 * which matters when it runs once per piece of work across a long session.
 */
export function lineDelta(before, after) {
  const pending = new Map()
  for (const line of String(before ?? '').split('\n')) {
    const text = line.trim()
    if (text) pending.set(text, (pending.get(text) || 0) + 1)
  }

  let added = 0
  for (const line of String(after ?? '').split('\n')) {
    const text = line.trim()
    if (!text) continue
    const left = pending.get(text) || 0
    if (left > 0) pending.set(text, left - 1)
    else added += 1
  }

  let removed = 0
  for (const left of pending.values()) removed += left
  return { added, removed }
}

/** The lines themselves, for explaining one moment. Capped, trimmed, in order. */
export function changedLines(before, after, cap = 30) {
  const pending = new Map()
  for (const line of String(before ?? '').split('\n')) {
    const text = line.trim()
    if (text) pending.set(text, (pending.get(text) || 0) + 1)
  }

  const added = []
  for (const line of String(after ?? '').split('\n')) {
    const text = line.trim()
    if (!text) continue
    const left = pending.get(text) || 0
    if (left > 0) pending.set(text, left - 1)
    else if (added.length < cap) added.push(clamp(text))
  }

  const removed = []
  for (const [text, left] of pending) {
    for (let i = 0; i < left && removed.length < cap; i += 1) removed.push(clamp(text))
  }

  return { added, removed }
}

/* ---------- reading the board ---------- */

const edgeKey = (edge) => (edge.from ?? edge.source) + '>' + (edge.to ?? edge.target)

/** The board's components and connections, keyed so two readings can be diffed. */
function boardOf(shapes) {
  const { nodes = [], edges = [], warnings = [] } = extractArchitecture(shapes ?? [])

  // A box nobody labelled is noise in a history: "Unnamed rect added" tells
  // nobody anything, and the parser already reports it as a warning.
  const named = nodes.filter((node) => node.label && !String(node.label).startsWith('Unnamed '))

  return {
    nodes: new Map(named.map((node) => [node.key, node])),
    edges: new Map(edges.map((edge) => [edgeKey(edge), edge])),
    warnings,
    shapeCount: (shapes ?? []).length,
  }
}

const EMPTY_BOARD = { nodes: new Map(), edges: new Map(), warnings: [], shapeCount: 0 }

/**
 * What changed between two points, as events.
 *
 * Architecture first, because that is what the summaries care about most and
 * what the board was drawn to say. Code second, named by what was declared
 * where possible. A board that changed without any component changing — a
 * sketch, an arrow nudged — is one quiet event rather than nothing, so the
 * timeline does not pretend nobody touched it.
 */
function diffEvents(before, after, at) {
  const events = []

  for (const [key, node] of after.board.nodes) {
    if (!before.board.nodes.has(key)) {
      events.push({ ...at, kind: 'architecture.added', text: node.label + ' added', detail: node.type || null })
    }
  }
  for (const [key, node] of before.board.nodes) {
    if (!after.board.nodes.has(key)) {
      events.push({ ...at, kind: 'architecture.removed', text: node.label + ' removed', detail: node.type || null })
    }
  }

  const label = (board, key) => board.nodes.get(key)?.label ?? key
  for (const [key, edge] of after.board.edges) {
    if (before.board.edges.has(key)) continue
    const from = label(after.board, edge.from ?? edge.source)
    const to = label(after.board, edge.to ?? edge.target)
    events.push({ ...at, kind: 'architecture.connected', text: from + ' connected to ' + to, detail: edge.label || null })
  }

  const architectureChanged = events.length > 0

  if (!architectureChanged && after.board.shapeCount !== before.board.shapeCount) {
    const delta = after.board.shapeCount - before.board.shapeCount
    events.push({
      ...at,
      kind: 'board.changed',
      text: 'Whiteboard ' + (delta > 0 ? 'drawn on (+' + delta : 'cleared (' + delta) + ' shapes)',
      detail: null,
    })
  }

  if (after.code !== before.code) {
    const { added, removed } = lineDelta(before.code, after.code)
    const introduced = [...after.names].filter((name) => !before.names.has(name))
    const dropped = [...before.names].filter((name) => !after.names.has(name))
    const lines = '+' + added + ' / -' + removed + ' lines'

    if (introduced.length) {
      events.push({
        ...at,
        kind: 'code.added',
        text: 'Code: added ' + introduced.slice(0, 5).join(', ') + (introduced.length > 5 ? ' and ' + (introduced.length - 5) + ' more' : ''),
        detail: lines,
      })
    } else if (dropped.length && added === 0) {
      events.push({ ...at, kind: 'code.removed', text: 'Code: removed ' + dropped.slice(0, 5).join(', '), detail: lines })
    } else if (added + removed > 0) {
      events.push({ ...at, kind: 'code.edited', text: 'Code edited', detail: lines })
    }
  }

  return events
}

/* ---------- walking the log ---------- */

function readState(doc) {
  const code = doc.getText('code').toString()
  return { code, names: declarationsIn(code), board: boardOf(doc.getArray('shapes').toJSON()) }
}

const EMPTY_STATE = { code: '', names: new Set(), board: EMPTY_BOARD }

/**
 * One pass over the update log, oldest first, splitting it into pieces of work
 * and describing what each one changed.
 *
 * Only the state at the end of the previous piece is held, never the whole
 * history of states: a long session is hundreds of pieces, and keeping every
 * one would cost memory in proportion to the room's age for no reason.
 */
async function walkLog(roomId) {
  const cursor = DocUpdate.find({ roomId })
    .select({ seq: 1, update: 1, actor: 1, createdAt: 1 })
    .sort({ seq: 1 })
    .limit(MAX_LOG_ENTRIES + 1)
    .cursor()

  const doc = new Y.Doc()
  const events = []
  const segments = []
  let previous = EMPTY_STATE
  let current = null
  let walked = 0
  let truncated = false

  const close = () => {
    if (!current) return
    const next = readState(doc)
    const at = { at: new Date(current.lastAt), seq: current.to, actorId: current.actor }
    events.push(...diffEvents(previous, next, at))
    segments.push({ from: current.from, to: current.to, at: new Date(current.lastAt), actorId: current.actor })
    previous = next
    current = null
  }

  try {
    for await (const entry of cursor) {
      if (walked >= MAX_LOG_ENTRIES) {
        truncated = true
        break
      }

      const at = new Date(entry.createdAt).getTime()
      const actor = entry.actor ? String(entry.actor) : null

      if (
        current &&
        (at - current.lastAt > SEGMENT_GAP_MS || actor !== current.actor || current.count >= SEGMENT_MAX_ENTRIES)
      ) {
        close()
      }

      Y.applyUpdate(doc, toUint8(entry.update))
      if (!current) current = { from: entry.seq, actor, count: 0 }
      current.to = entry.seq
      current.lastAt = at
      current.count += 1

      walked += 1
      if (walked % YIELD_EVERY === 0) await yieldToLoop()
    }
    close()
  } finally {
    doc.destroy()
  }

  return { events, segments, final: previous, truncated }
}

/** The log position a moment in time corresponds to, for seeking. */
function seqAtTime(segments, at) {
  const time = new Date(at).getTime()
  let found = 0
  for (const segment of segments) {
    if (segment.at.getTime() <= time) found = segment.to
    else break
  }
  return found
}

/* ---------- everything that is not the log ---------- */

const TERMINAL = ['completed', 'failed', 'timed_out', 'resource_limit', 'cancelled']

function runEvent(run) {
  const at = run.finishedAt ?? run.createdAt
  const who = { actorId: run.user ? String(run.user) : null, actorName: run.userName ?? null }
  const language = run.language || 'code'

  if (run.state === 'completed') {
    return { at, ...who, kind: 'execution.succeeded', text: 'Run succeeded (' + language + ')', detail: null }
  }

  const firstError = String(run.stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)

  const reason =
    run.state === 'timed_out'
      ? 'timed out'
      : run.state === 'resource_limit'
        ? 'hit a resource limit'
        : run.state === 'cancelled'
          ? 'was cancelled'
          : 'failed'

  return {
    at,
    ...who,
    kind: run.state === 'cancelled' ? 'execution.cancelled' : 'execution.failed',
    text: 'Run ' + reason + ' (' + language + ')',
    detail: firstError ? clamp(firstError) : null,
  }
}

function activityEvent(row) {
  const who = { actorId: row.actor ? String(row.actor) : null, actorName: row.actorName ?? null }
  if (row.kind === ACTIVITY.COLLABORATOR_JOINED) {
    return { at: row.at, ...who, kind: 'people.joined', text: 'joined the room', detail: row.detail ?? null }
  }
  // What was said is never recorded; only that a conversation happened.
  return { at: row.at, ...who, kind: 'people.chatted', text: 'talked in chat', detail: null }
}

function generationEvents(generation) {
  const events = [
    {
      at: generation.createdAt,
      actorId: generation.requestedBy ? String(generation.requestedBy) : null,
      actorName: generation.requestedByName ?? null,
      kind: 'ai.proposed',
      text: 'AI proposed ' + (generation.files?.length ?? 0) + ' file(s) from the whiteboard',
      detail: generation.summary ? clamp(generation.summary) : null,
    },
  ]

  const applied = (generation.files ?? []).filter((file) => file.appliedAt)
  if (applied.length) {
    const last = applied.reduce((latest, file) => (file.appliedAt > latest ? file.appliedAt : latest), applied[0].appliedAt)
    events.push({
      at: last,
      actorId: generation.requestedBy ? String(generation.requestedBy) : null,
      actorName: generation.requestedByName ?? null,
      kind: 'ai.applied',
      text: 'Applied ' + applied.length + ' AI-generated file(s)',
      detail: clamp(applied.map((file) => file.path).slice(0, 4).join(', ')),
    })
  }

  return events
}

/* ---------- the timeline ---------- */

/** Everything a timeline is built from, cheaply, so a cache can be trusted. */
export async function timelineSignature(roomId) {
  const [last, runs, activity, generations] = await Promise.all([
    DocUpdate.findOne({ roomId }).sort({ seq: -1 }).select({ seq: 1 }).lean(),
    Execution.countDocuments({ roomId, state: { $in: TERMINAL } }),
    Activity.countDocuments({
      roomId,
      kind: { $in: [ACTIVITY.COLLABORATOR_JOINED, ACTIVITY.COMMENT_ADDED] },
    }),
    Generation.countDocuments({ roomId }),
  ])

  const throughSeq = last?.seq ?? 0
  return { throughSeq, signature: [throughSeq, runs, activity, generations].join(':') }
}

/** Which events to let go of first when a session has more than can be shown. */
const EXPENDABLE = ['board.changed', 'people.chatted', 'code.edited']

function cap(events) {
  if (events.length <= MAX_EVENTS) return { events, truncated: false }

  let kept = events
  for (const kind of EXPENDABLE) {
    if (kept.length <= MAX_EVENTS) break
    const excess = kept.length - MAX_EVENTS
    let dropped = 0
    kept = kept.filter((event) => {
      if (dropped < excess && event.kind === kind) {
        dropped += 1
        return false
      }
      return true
    })
  }

  return { events: kept.slice(0, MAX_EVENTS), truncated: true }
}

async function namesFor(ids) {
  const valid = [...new Set(ids)].filter((id) => id && mongoose.isValidObjectId(id))
  if (!valid.length) return new Map()
  const users = await User.find({ _id: { $in: valid } }).select({ name: 1 }).lean()
  return new Map(users.map((user) => [String(user._id), user.name]))
}

/**
 * The session as a list of events, oldest first, each with a stable id.
 *
 * Ids are assigned after sorting, so the same history always produces the same
 * ids — which is what lets a cached summary's citations still point at the
 * right events when the timeline is read again.
 */
export async function buildSessionTimeline(roomId) {
  const { throughSeq, signature } = await timelineSignature(roomId)

  const cached = cache.get(roomId)
  if (cached?.signature === signature) return cached.timeline

  const [log, runs, activity, generations] = await Promise.all([
    walkLog(roomId),
    Execution.find({ roomId, state: { $in: TERMINAL } })
      .select({ state: 1, language: 1, stderr: 1, user: 1, userName: 1, finishedAt: 1, createdAt: 1 })
      .sort({ createdAt: 1 })
      .limit(MAX_RUNS)
      .lean(),
    Activity.find({ roomId, kind: { $in: [ACTIVITY.COLLABORATOR_JOINED, ACTIVITY.COMMENT_ADDED] } })
      .sort({ at: 1 })
      .limit(MAX_RUNS)
      .lean(),
    Generation.find({ roomId })
      .select({ requestedBy: 1, requestedByName: 1, summary: 1, files: 1, createdAt: 1 })
      .sort({ createdAt: 1 })
      .limit(50)
      .lean(),
  ])

  const merged = [
    ...log.events,
    ...runs.map(runEvent),
    ...activity.map(activityEvent),
    ...generations.flatMap(generationEvents),
  ]
    .filter((event) => event.at)
    .sort((a, b) => new Date(a.at) - new Date(b.at))

  // Problems still standing at the end of the session. These are facts about
  // the final board, and what "unresolved" is allowed to be built on.
  const endAt = merged.at(-1)?.at ?? null
  if (endAt) {
    for (const warning of log.final.board.warnings.slice(0, 10)) {
      merged.push({
        at: endAt,
        actorId: null,
        kind: 'state.warning',
        text: clamp(warning.message),
        detail: 'still true at the end of the session',
      })
    }
  }

  const { events: kept, truncated: tooMany } = cap(merged)
  const names = await namesFor(kept.map((event) => event.actorId))
  const start = kept.length ? new Date(kept[0].at).getTime() : 0

  const events = kept.map((event, index) => {
    const at = new Date(event.at)
    return {
      id: 'e' + (index + 1),
      at: at.toISOString(),
      offsetMs: at.getTime() - start,
      clock: clockOf(at.getTime() - start),
      seq: event.seq ?? seqAtTime(log.segments, at),
      kind: event.kind,
      actor: event.actorName ?? names.get(event.actorId) ?? (event.actorId ? 'Someone' : null),
      text: event.text,
      detail: event.detail ?? null,
    }
  })

  const timeline = {
    roomId,
    throughSeq,
    signature,
    startedAt: events[0]?.at ?? null,
    endedAt: events.at(-1)?.at ?? null,
    truncated: log.truncated || tooMany,
    segments: log.segments.map((segment) => ({ from: segment.from, to: segment.to })),
    events,
  }

  cache.delete(roomId)
  cache.set(roomId, { signature, timeline })
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)

  return timeline
}

/**
 * What exactly changed at one point in the log.
 *
 * The piece of work containing `seq` is compared from just before it began to
 * `seq` itself, using the replay engine's own checkpointed reads — the same
 * states the scrubber shows, so the explanation describes what is on screen.
 */
export async function momentAt(roomId, seq, timeline) {
  const segment =
    timeline.segments.find((entry) => entry.from <= seq && seq <= entry.to) ??
    [...timeline.segments].reverse().find((entry) => entry.to <= seq) ??
    null

  const beforeSeq = segment ? Math.max(0, segment.from - 1) : Math.max(0, seq - 1)

  const read = async (at) => {
    if (at <= 0) return EMPTY_STATE
    const { state } = await stateAt(roomId, at)
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, toUint8(state))
      return readState(doc)
    } finally {
      doc.destroy()
    }
  }

  const [before, after] = await Promise.all([read(beforeSeq), read(seq)])
  const changes = diffEvents(before, after, { at: null, seq, actorId: null })

  return {
    fromSeq: beforeSeq,
    seq,
    changes: changes.map((event) => (event.detail ? event.text + ' (' + event.detail + ')' : event.text)),
    lines: changedLines(before.code, after.code),
  }
}
