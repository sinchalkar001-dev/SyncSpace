import { DocUpdate } from '../../models/DocUpdate.js'
import { CopilotRun } from '../../models/CopilotRun.js'
import { ACTIVITY, recordActivity } from '../activity.service.js'
import { getIo } from '../../realtime/registry.js'
import { env } from '../../config/env.js'
import { badRequest, forbidden, notFound, tooMany } from '../../errors.js'
import { CAPABILITIES, can } from '../../permissions.js'
import { streamModelTool } from '../ai.service.js'
import { reconcileWithRoom } from '../generation.service.js'
import { actionById, systemFor } from './actions.js'
import { sanitiseResult, STREAM_FIELD, toolFor } from './blocks.js'
import { describeSources, gatherSources } from './sources.js'

/**
 * One copilot action, from the button to the record.
 *
 * The order here is the order the guarantees are made in, and it is not
 * arbitrary:
 *
 *  1. Permission, before anything is read. A refusal must not be preceded by
 *     the server reading the room on the refused person's behalf.
 *  2. Sources, and they are announced before the answer starts. The person
 *     sees what is being read while it is being read, not as a footnote
 *     written afterwards by the thing being audited.
 *  3. The model, streamed.
 *  4. Sanitising, grounding, and reconciling against the room — the three
 *     places an answer stops being text and starts being something the room
 *     might act on.
 *  5. The record, written whether it worked or not.
 *
 * Nothing in this file writes to the room. Files go through the review in
 * apply.js and the buffer through the client's own Yjs transaction; what
 * happens here produces a proposal and never a change.
 */

/** How many copilot answers one person may have in flight at once. */
const inflight = new Map()

function claimSlot(key) {
  const held = inflight.get(key) ?? 0
  if (held >= env.COPILOT_MAX_CONCURRENT) {
    throw tooMany(
      'You already have ' +
        held +
        ' copilot ' +
        (held === 1 ? 'answer' : 'answers') +
        ' in progress. Wait for ' +
        (held === 1 ? 'it' : 'one') +
        ' to finish.',
      'copilot_busy'
    )
  }
  inflight.set(key, held + 1)
}

function releaseSlot(key) {
  const held = (inflight.get(key) ?? 1) - 1
  if (held <= 0) inflight.delete(key)
  else inflight.set(key, held)
}

/** Test seam: forgets everything believed to be running. */
export function resetCopilotSlots() {
  inflight.clear()
}

/**
 * What an action said it cannot proceed without.
 *
 * Checked here, before a single source is read, so an action that needs a
 * selection refuses in the same sentence the button's tooltip uses rather than
 * failing part way through gathering. Most actions need nothing: they read the
 * whole buffer and narrow to a selection if there happens to be one.
 */
const REQUIREMENTS = Object.freeze({
  selection: {
    has: (input) => input?.startLine != null && input?.endLine != null,
    say: 'Select some code first — this one is about what you have highlighted.',
  },
  seq: {
    has: (input) => input?.seq != null,
    say: 'Pause the replay somewhere first — this one is about a point in the history.',
  },
  range: {
    has: (input) => input?.fromSeq != null && (input?.toSeq ?? input?.seq) != null,
    say: 'Choose two points in the history first — this one compares them.',
  },
})

function assertHasWhatItNeeds(action, input) {
  if (!action.needs) return
  const requirement = REQUIREMENTS[action.needs]
  if (!requirement.has(input)) throw badRequest(requirement.say, 'needs_' + action.needs)
}

/** Where the room's history stood when this was asked. */
async function logPosition(roomId) {
  const last = await DocUpdate.findOne({ roomId }).sort({ seq: -1 }).select({ seq: 1 }).lean()
  return last?.seq ?? 0
}

/**
 * The prompt: what was read, then what to do with it.
 *
 * Sources go in first and the request last. A model given the instruction
 * before the material tends to answer from the instruction — which for
 * "review this architecture" means a review of architectures in general.
 */
function buildPrompt(action, sources, input, toolName) {
  const material = sources
    .map((source) =>
      source.text
        ? source.text
        : source.label.toUpperCase() + ': nothing recorded in this room yet.'
    )
    .join('\n\n')

  const note = typeof input?.note === 'string' ? input.note.trim() : ''

  // Assembled rather than filtered: the blank lines between the sections are
  // the separators, and filtering out the falsy entries would take them with
  // the optional ones and run the whole prompt together.
  const parts = ['THE ROOM, AS FAR AS THIS REQUEST IS CONCERNED', '', material, '']

  if (note) parts.push('WHAT THE PERSON ASKING ADDED', note, '')

  parts.push('Answer with the ' + toolName + ' tool.')

  return parts.join('\n')
}

/**
 * Keeps the citations that name events which exist.
 *
 * Weaker than the per-statement grounding in session-insight.service.js, which
 * drops any sentence resting on nothing — that is the right design where the
 * whole answer is a list of claims, and this is not. Here the citations travel
 * beside the prose with the events attached, so a reader can check the answer
 * against the record in one click. What this does guarantee is that no
 * citation shown was invented: an id that is not in the timeline is dropped
 * and counted, and the count is displayed.
 */
function groundCitations(ids, timeline) {
  if (!timeline) return { citations: [], cited: {}, discarded: ids.length }

  const byId = new Map(timeline.events.map((event) => [event.id, event]))
  const kept = ids.filter((id) => byId.has(id))

  const cited = {}
  for (const id of kept) {
    const event = byId.get(id)
    cited[id] = {
      clock: event.clock,
      seq: event.seq,
      kind: event.kind,
      actor: event.actor,
      text: event.text,
      detail: event.detail,
    }
  }

  return { citations: kept, cited, discarded: ids.length - kept.length }
}

/**
 * Tells the room somebody asked the copilot something.
 *
 * The answer is not broadcast, only that it happened and what it was about. An
 * answer can be a page of review notes and pushing that at four people who did
 * not ask would be worse than not telling them; the run id is enough for
 * anybody who wants to read it.
 */
function announce(roomId, run) {
  getIo()?.to(roomId).emit('copilot:run', { roomId, run: run.toSummary() })
}

export function assertCanUseCopilot(room, userId) {
  if (!can(room, userId, CAPABILITIES.COPILOT_USE)) {
    throw forbidden(
      userId
        ? 'Your role in this room does not include the copilot'
        : 'Sign in to use the copilot in this room',
      'copilot_forbidden'
    )
  }
}

/**
 * Runs one action and records it.
 *
 * `onEvent` is how the answer reaches the browser as it is written — the route
 * turns each call into an SSE frame. It is optional: without it this is an
 * ordinary request that happens to take a while, which is what makes the
 * whole path testable without a stream.
 */
export async function runCopilotAction({ room, user, actionId, input = {}, onEvent, signal }) {
  const action = actionById(actionId)
  if (!action) throw notFound('No such copilot action', 'unknown_action')

  assertCanUseCopilot(room, user?.id)
  assertHasWhatItNeeds(action, input)

  const roomId = room.roomId
  const slot = String(user.id)
  claimSlot(slot)

  const started = Date.now()

  try {
    const [sources, throughSeq] = await Promise.all([
      gatherSources(action.sources, { roomId, room, user, input }),
      logPosition(roomId),
    ])

    const described = describeSources(sources)
    onEvent?.('sources', { sources: described, action: action.id })

    const tool = toolFor(action)

    let answer
    try {
      answer = await streamModelTool({
        system: systemFor(action),
        prompt: buildPrompt(action, sources, input, tool.name),
        tool,
        streamField: STREAM_FIELD,
        onDelta: (text) => onEvent?.('delta', { text }),
        signal,
        hints: {
          timeout: 'The model did not answer in time. Try again, or narrow what you are asking about.',
          cutoff: 'The answer was cut off before it was complete. Try a smaller selection.',
        },
      })
    } catch (error) {
      // Recorded as well as thrown. A room where the copilot keeps timing out
      // should look like one, rather than like a room where nobody tried.
      const failure = await CopilotRun.create({
        roomId,
        actionId: action.id,
        context: action.context,
        requestedBy: user.id,
        requestedByName: user.name ?? null,
        status: 'failed',
        input,
        sources: described,
        throughSeq,
        error: String(error?.message ?? 'The copilot could not answer').slice(0, 300),
        durationMs: Date.now() - started,
      })

      error.run = failure.toSummary()
      throw error
    }

    const { result, rejected } = sanitiseResult(action, answer.input)

    /**
     * The change set, decided against the room rather than taken from the
     * answer. A model that has not seen the room's files calls everything a
     * create; `reconcileWithRoom` turns one landing on an existing name into a
     * modification carrying the current contents, which is what keeps
     * "generate" from quietly meaning "overwrite".
     */
    const changeSet = action.apply?.kind === 'files' && result.files?.length
      ? await reconcileWithRoom(roomId, result.files)
      : { files: [], notes: [] }

    const grounded = action.grounded
      ? groundCitations(result.citations ?? [], sources.find((source) => source.timeline)?.timeline)
      : null

    if (grounded) {
      result.citations = grounded.citations
      result.cited = grounded.cited
    }

    const patch = buildPatch(action, result, sources)
    // The buffer is proposed whole, so the prose is the only place the change
    // is described; keeping the raw block as well would show it twice.
    delete result.patch

    const run = await CopilotRun.create({
      roomId,
      actionId: action.id,
      context: action.context,
      requestedBy: user.id,
      requestedByName: user.name ?? null,
      status: 'succeeded',
      input,
      sources: described,
      throughSeq,
      answer: result.answer,
      result,
      files: changeSet.files.map((file) => ({
        path: file.path,
        action: file.action,
        language: file.language,
        contents: file.contents,
        rationale: file.rationale,
        size: file.size,
        status: 'proposed',
      })),
      patch,
      rejected: [...rejected, ...changeSet.notes],
      discarded: grounded?.discarded ?? 0,
      model: answer.model,
      provider: answer.provider,
      streamed: answer.streamed !== false,
      usage: answer.usage,
      durationMs: Date.now() - started,
    })

    recordActivity({
      roomId,
      kind: ACTIVITY.COPILOT_ANSWERED,
      actor: user.id,
      actorName: user.name ?? null,
      detail: action.title,
    })

    announce(roomId, run)

    const payload = run.toPublic()
    onEvent?.('result', { run: payload })
    return payload
  } finally {
    releaseSlot(slot)
  }
}

/**
 * Puts the buffer's own line endings back on a proposed replacement.
 *
 * The model is shown the code with them normalised, because they are invisible
 * and it should not be spending attention on them — and it answers in whatever
 * it likes. Without this, a buffer any Windows editor has touched comes back
 * with every CRLF turned into an LF, so the "minimal" change is every line in
 * the file, over characters nobody reviewing it can see. The model does not
 * get to decide this.
 */
export function matchLineEndings(contents, base) {
  const normalised = contents.replace(/\r\n/g, '\n')
  return base.includes('\r\n') ? normalised.replace(/\n/g, '\r\n') : normalised
}

/**
 * A buffer replacement, with the text it was written against.
 *
 * Refused here rather than later if the action never read the buffer: a patch
 * with nothing to compare against could only be applied blind, and applying a
 * model's output blind over a document three people are editing is the exact
 * thing this feature is not allowed to do.
 */
function buildPatch(action, result, sources) {
  if (action.apply?.kind !== 'code' || !result.patch) return null

  const base = sources.find((source) => source.key === 'code')?.raw
  if (typeof base !== 'string') return null

  const contents = matchLineEndings(result.patch.contents, base)

  // A "change" that changes nothing is not worth a review screen.
  if (contents === base) return null

  return {
    contents,
    rationale: result.patch.rationale,
    baseText: base,
    status: 'proposed',
  }
}

/** The room's copilot history, newest first. */
export async function listCopilotRuns(roomId, { limit = 20 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 50)
  const rows = await CopilotRun.find({ roomId }).sort({ createdAt: -1 }).limit(capped)
  return rows.map((row) => row.toSummary())
}

export async function getCopilotRun(roomId, runId) {
  if (!/^[0-9a-f]{24}$/i.test(String(runId))) {
    throw badRequest('That is not a copilot run id', 'bad_run_id')
  }

  // Scoped to the room in the query, so an id from another room is simply not
  // found rather than checked and refused.
  const run = await CopilotRun.findOne({ _id: runId, roomId })
  if (!run) throw notFound('No such copilot run in this room', 'run_not_found')
  return run
}
