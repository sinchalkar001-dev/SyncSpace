import { SessionInsight } from '../models/SessionInsight.js'
import { callModelTool } from './ai.service.js'
import { buildSessionTimeline, momentAt, timelineSignature } from './session-timeline.service.js'
import { badRequest } from '../errors.js'
import { env } from '../config/env.js'

/**
 * A model reading a session's history, and being held to it.
 *
 * The whole design is aimed at one failure: a summary that sounds right and is
 * not. A model asked to "summarise this session" will happily describe the
 * authentication flow somebody obviously meant to build, in a room where
 * nobody drew one. So it is never shown the room. It is shown the timeline —
 * the list of events the system recorded, each with an id — and made to cite
 * an id for every statement it makes.
 *
 * Then the citations are checked here, not trusted. A statement citing no
 * event, or only events that do not exist, is dropped before anybody sees it,
 * and the number dropped is kept and shown. What survives can be checked by
 * a person too: every citation in the interface opens the event it rests on.
 *
 * That makes invention hard, not impossible — a model could cite a real event
 * and misdescribe it — which is why the events travel with the summary and are
 * one click away from every sentence.
 *
 * Nothing here touches replay. These are separate requests, answered from a
 * cache whenever the history has not moved, and a model call is network time
 * spent awaiting, not work done on the thread that serves frames.
 */

const SECTIONS = ['decisions', 'architecture', 'code', 'failed', 'succeeded', 'unresolved', 'collaboration']

const MAX_ITEMS = 8
const MAX_CITATIONS = 8
const MAX_STATEMENT = 400

/** Output ceiling for these answers; far below what a change set needs. */
const SUMMARY_TOKENS = 4000
const MOMENT_TOKENS = 1500

/** Events handed to a moment's explanation: its lead-up, and a little after. */
const BEFORE = 12
const AFTER = 4

const clamp = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

const statement = (description) => ({
  type: 'object',
  description,
  properties: {
    text: {
      type: 'string',
      description: 'One sentence, stating only what the cited events show.',
    },
    events: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ids of the events this statement rests on, such as "e4". At least one.',
    },
  },
  required: ['text', 'events'],
})

const list = (description) => ({ type: 'array', description, items: statement(description) })

export const SUMMARY_TOOL = {
  name: 'summarize_session',
  description: 'Record a summary of a recorded collaborative session, grounded in its events.',
  input_schema: {
    type: 'object',
    properties: {
      overview: statement('At most two sentences: what this session produced.'),
      decisions: list(
        'Choices visible in the events: something added and kept, a proposal applied, one approach replaced by another.'
      ),
      architecture: list('How the system drawn on the whiteboard changed.'),
      code: list('What was written or removed in the code.'),
      failed: list('Approaches that did not work: failed runs, components removed, code abandoned.'),
      succeeded: list('What worked: successful runs, changes that were kept.'),
      unresolved: list(
        'Problems still standing at the end: a failure with no later success, a warning still true.'
      ),
      collaboration: list('Who joined, who worked on what, and when people talked.'),
    },
    required: ['overview', ...SECTIONS],
  },
}

export const MOMENT_TOOL = {
  name: 'explain_moment',
  description: 'Explain one moment of a recorded session, grounded in its events.',
  input_schema: {
    type: 'object',
    properties: {
      explanation: statement(
        'What was happening at this moment. Cite "now" for the change at this exact point.'
      ),
      context: list('What led up to it, in order.'),
      next: list('What the events show happened soon after, if anything.'),
    },
    required: ['explanation', 'context'],
  },
}

const RULES = [
  'Rules:',
  '- Every statement must cite at least one event id from the list, in "events". A statement',
  '  with no valid id is thrown away before anybody sees it.',
  '- Say what the events show and nothing more. Do not guess why something was done. Do not',
  '  name technologies, libraries, files or people that are not in the events. Do not describe',
  '  code you were not shown.',
  '- If there is nothing the events support, return an empty list. Empty is correct; padded is',
  '  wrong.',
  '- A failed run followed later by a successful one is a failure and then a success, in that',
  '  order. Do not merge them into "it worked".',
  '- One sentence per statement. Plain, specific, past tense.',
].join('\n')

const SUMMARY_SYSTEM = [
  'You write the record of a collaborative engineering session from a list of events that the',
  'system itself recorded while people worked on a shared whiteboard and a shared code buffer.',
  '',
  'The events are the only facts you have. You were not in the room, you cannot see the code or',
  'the whiteboard, and nobody’s chat messages are available — only that a conversation happened.',
  '',
  RULES,
  '- "unresolved" means still standing at the end: a failing run with no later success, or a',
  '  warning marked as still true at the end of the session.',
].join('\n')

const MOMENT_SYSTEM = [
  'You explain one moment of a recorded collaborative engineering session to somebody who has',
  'paused a replay at that point. You are given the events around it, and "now": what changed at',
  'exactly this point in the history.',
  '',
  'The events are the only facts you have. Chat messages are not available.',
  '',
  RULES,
  '- Cite "now" when describing what changed at this exact point.',
].join('\n')

/* ---------- prompts ---------- */

const line = (event) =>
  event.id +
  '  ' +
  event.clock +
  '  ' +
  event.kind +
  '  ' +
  (event.actor ? event.actor + ': ' : '') +
  event.text +
  (event.detail ? ' [' + event.detail + ']' : '')

function sessionHeader(timeline) {
  const people = [...new Set(timeline.events.map((event) => event.actor).filter(Boolean))]
  const length = timeline.events.at(-1)?.clock ?? '00:00'

  return [
    'Session length: ' + length + '. People: ' + (people.length ? people.join(', ') : 'unrecorded') + '.',
    timeline.events.length + ' events.',
    timeline.truncated
      ? 'The history was longer than could be read in full; later events are not included.'
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}

export function summaryPrompt(timeline) {
  return [
    sessionHeader(timeline),
    '',
    'Events (id  time  kind  who: what [detail]):',
    ...timeline.events.map(line),
  ].join('\n')
}

function momentPrompt(timeline, window, moment, clock) {
  return [
    sessionHeader(timeline),
    '',
    'The replay is paused at ' + clock + ' (log position ' + moment.seq + ').',
    '',
    'now  ' + clock + '  moment.change  What changed at this exact point:',
    ...(moment.changes.length ? moment.changes.map((change) => '  - ' + change) : ['  - (no visible change)']),
    ...(moment.lines.added.length ? ['  Lines added:', ...moment.lines.added.map((text) => '    + ' + text)] : []),
    ...(moment.lines.removed.length ? ['  Lines removed:', ...moment.lines.removed.map((text) => '    - ' + text)] : []),
    '',
    'Events around it (id  time  kind  who: what [detail]):',
    ...window.map(line),
  ].join('\n')
}

/* ---------- holding the answer to the events ---------- */

/**
 * Keeps a statement only if it rests on events that exist.
 *
 * Unknown ids are stripped and counted; a statement left with none is dropped
 * and counted. Nothing the model wrote is shown without at least one real
 * event behind it.
 */
function ground(raw, known, stats) {
  if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) {
    if (raw) stats.discarded += 1
    return null
  }

  const cited = [...new Set((Array.isArray(raw.events) ? raw.events : []).map((id) => String(id).trim()))]
  const events = cited.filter((id) => known.has(id)).slice(0, MAX_CITATIONS)

  if (!events.length) {
    stats.discarded += 1
    return null
  }

  return { text: clamp(raw.text, MAX_STATEMENT), events }
}

const groundList = (items, known, stats) =>
  (Array.isArray(items) ? items : [])
    .slice(0, MAX_ITEMS)
    .map((item) => ground(item, known, stats))
    .filter(Boolean)

/**
 * The events a result cites, copied into it.
 *
 * Event ids are positions in a timeline, and a timeline can be rebuilt with
 * slightly different contents — run records expire, for one. A cached summary
 * that looked its citations up afresh could end up pointing at the wrong
 * events. Carrying a copy means a summary always shows what it was built from.
 */
function citedEvents(result, byId) {
  const ids = new Set()
  const visit = (value) => {
    if (!value) return
    if (Array.isArray(value)) value.forEach(visit)
    else if (Array.isArray(value.events)) value.events.forEach((id) => ids.add(id))
  }
  Object.values(result).forEach(visit)

  const cited = {}
  for (const id of ids) {
    const event = byId.get(id)
    if (event) {
      cited[id] = {
        clock: event.clock,
        seq: event.seq,
        kind: event.kind,
        actor: event.actor,
        text: event.text,
        detail: event.detail,
      }
    }
  }
  return cited
}

/** Concurrent identical requests share one model call instead of paying twice. */
const inflight = new Map()

async function once(key, work) {
  if (inflight.has(key)) return inflight.get(key)
  const promise = work().finally(() => inflight.delete(key))
  inflight.set(key, promise)
  return promise
}

const author = (user) => ({ createdBy: user?.id ?? null, createdByName: user?.name ?? null })

/* ---------- the session ---------- */

/** The newest summary of a room, and whether the history has moved since. */
export async function latestSummary(roomId) {
  const [latest, { signature }] = await Promise.all([
    SessionInsight.findOne({ roomId, kind: 'session' }).sort({ createdAt: -1 }),
    timelineSignature(roomId),
  ])

  return {
    summary: latest ? latest.toPublic() : null,
    current: Boolean(latest) && latest.signature === signature,
  }
}

/**
 * Summarises the session, or returns the summary already written for exactly
 * this history.
 */
export async function summarizeSession({ roomId, user }) {
  const timeline = await buildSessionTimeline(roomId)

  if (!timeline.events.length) {
    throw badRequest(
      'Nothing has happened in this room yet, so there is nothing to summarise.',
      'nothing_to_summarize'
    )
  }

  const existing = await SessionInsight.findOne({
    roomId,
    kind: 'session',
    signature: timeline.signature,
  }).sort({ createdAt: -1 })

  if (existing) return { summary: existing.toPublic(), cached: true }

  return once(roomId + ':session:' + timeline.signature, async () => {
    const answer = await callModelTool({
      system: SUMMARY_SYSTEM,
      prompt: summaryPrompt(timeline),
      tool: SUMMARY_TOOL,
      maxTokens: Math.min(env.AI_MAX_OUTPUT_TOKENS, SUMMARY_TOKENS),
      hints: {
        timeout: 'The model did not answer in time. Try again in a moment.',
        cutoff: 'The summary was cut off before it was complete. Try again.',
      },
    })

    const byId = new Map(timeline.events.map((event) => [event.id, event]))
    const known = new Set(byId.keys())
    const stats = { discarded: 0 }

    const sections = { overview: ground(answer.input.overview, known, stats) }
    for (const name of SECTIONS) sections[name] = groundList(answer.input[name], known, stats)

    const row = await SessionInsight.create({
      roomId,
      kind: 'session',
      signature: timeline.signature,
      throughSeq: timeline.throughSeq,
      result: { sections, cited: citedEvents(sections, byId), eventCount: timeline.events.length },
      discarded: stats.discarded,
      model: answer.model,
      provider: answer.provider,
      usage: answer.usage,
      ...author(user),
    })

    return { summary: row.toPublic(), cached: false }
  })
}

/* ---------- one moment ---------- */

/**
 * Explains the point somebody paused the replay on.
 *
 * Given the lead-up and the short aftermath rather than the whole session: a
 * moment is local, and handing over two hundred events to explain one of them
 * costs more and invites the answer to wander off to whatever else happened.
 */
export async function explainMoment({ roomId, user, seq }) {
  const timeline = await buildSessionTimeline(roomId)
  const target = Number(seq)

  if (!Number.isInteger(target) || target < 1 || target > timeline.throughSeq) {
    throw badRequest('That point is not in this room’s history.', 'bad_seq')
  }

  const existing = await SessionInsight.findOne({
    roomId,
    kind: 'moment',
    signature: timeline.signature,
    atSeq: target,
  }).sort({ createdAt: -1 })

  if (existing) return { moment: existing.toPublic(), cached: true }

  return once(roomId + ':moment:' + timeline.signature + ':' + target, async () => {
    const before = timeline.events.filter((event) => event.seq <= target).slice(-BEFORE)
    const after = timeline.events.filter((event) => event.seq > target).slice(0, AFTER)
    const window = [...before, ...after]

    const moment = await momentAt(roomId, target, timeline)
    const clock = before.at(-1)?.clock ?? '00:00'

    const answer = await callModelTool({
      system: MOMENT_SYSTEM,
      prompt: momentPrompt(timeline, window, moment, clock),
      tool: MOMENT_TOOL,
      maxTokens: Math.min(env.AI_MAX_OUTPUT_TOKENS, MOMENT_TOKENS),
      hints: {
        timeout: 'The model did not answer in time. Try again in a moment.',
        cutoff: 'The explanation was cut off before it was complete. Try again.',
      },
    })

    const byId = new Map(window.map((event) => [event.id, event]))
    byId.set('now', {
      clock,
      seq: target,
      kind: 'moment.change',
      actor: null,
      text: 'What changed at this point',
      detail: moment.changes.join('; ') || 'no visible change',
    })

    const known = new Set(byId.keys())
    const stats = { discarded: 0 }

    const result = {
      explanation: ground(answer.input.explanation, known, stats),
      context: groundList(answer.input.context, known, stats),
      next: groundList(answer.input.next, known, stats),
    }

    const row = await SessionInsight.create({
      roomId,
      kind: 'moment',
      signature: timeline.signature,
      throughSeq: timeline.throughSeq,
      atSeq: target,
      result: { ...result, clock, changes: moment.changes, cited: citedEvents(result, byId) },
      discarded: stats.discarded,
      model: answer.model,
      provider: answer.provider,
      usage: answer.usage,
      ...author(user),
    })

    return { moment: row.toPublic(), cached: false }
  })
}
