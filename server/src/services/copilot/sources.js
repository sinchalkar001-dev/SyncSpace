import { Execution } from '../../models/Execution.js'
import { CommentThread } from '../../models/Comment.js'
import { File } from '../../models/File.js'
import { architectureToPrompt, extractArchitecture } from '../architecture.service.js'
import { readRoomCode, readRoomShapes } from '../generation.service.js'
import { snapshotJsonAt } from '../replay.service.js'
import { buildSessionTimeline, changedLines, momentAt } from '../session-timeline.service.js'
import { badRequest } from '../../errors.js'

/**
 * Where the copilot's facts come from, and how it says so.
 *
 * Every action names the sources it reads. Nothing else is gathered, and
 * nothing gathered goes unmentioned: each source answers with a label and a
 * count alongside the text that goes into the prompt, and those labels are the
 * chips the panel shows before the answer starts arriving. That is the whole
 * of "show which room data was used" — not a footnote written afterwards by
 * the thing being audited, but the same list the prompt was built from.
 *
 * It is also the privacy boundary. "Explain this selection" reads the code and
 * nothing else; it does not quietly carry the room's comment threads along
 * because they were convenient. A source that is not declared is not read.
 *
 * Sources read the server's own copy of the room rather than accepting one in
 * the request. The client sends coordinates — a line range, a log position, a
 * run id — and the server resolves them against what it has. A prompt
 * assembled from client-supplied text would be a prompt anybody could write.
 */

/** Ceilings on what one source may contribute, in characters. */
const MAX_CODE = 24_000
const MAX_SELECTION = 12_000
const MAX_OUTPUT = 2_500
const MAX_BRIEF_OUTPUT = 600
const RECENT_RUNS = 6
const MAX_THREADS = 30
const MAX_FILES = 40

const truncate = (text, limit, what = 'characters') =>
  text.length > limit
    ? text.slice(0, limit) + '\n… [truncated at ' + limit + ' ' + what + ']'
    : text

const plural = (count, one, many = one + 's') => count + ' ' + (count === 1 ? one : many)

/**
 * Code with line numbers, because every other part of the answer cites them.
 *
 * Line endings are normalised on the way in. A buffer any Windows editor has
 * touched is full of carriage returns, and leaving them would put an invisible
 * character at the end of every line of the prompt — which the model is then
 * liable to reproduce, or to drop, in a way nobody reviewing the answer can
 * see. `matchLineEndings` in run.js puts the buffer's own back on afterwards.
 */
function numbered(code, from = 1) {
  return code
    .split(/\r?\n/)
    .map((line, index) => String(from + index).padStart(4, ' ') + '  ' + line)
    .join('\n')
}

const outputOf = (run, limit) =>
  [
    run.stdout ? 'stdout:\n' + truncate(run.stdout, limit) : null,
    run.stderr ? 'stderr:\n' + truncate(run.stderr, limit) : null,
  ]
    .filter(Boolean)
    .join('\n') || '(no output)'

const runHeadline = (run) =>
  [
    run.language,
    run.state,
    run.termination && run.termination !== 'none' ? run.termination : null,
    typeof run.exitCode === 'number' ? 'exit ' + run.exitCode : null,
    run.durationMs != null ? run.durationMs + 'ms' : null,
    run.userName ? 'by ' + run.userName : null,
  ]
    .filter(Boolean)
    .join(' · ')

/**
 * One run in full, chosen the way a person would choose it.
 *
 * With no id, the most recent *failure* wins over the most recent run. Someone
 * opening "Explain error" has just watched something go wrong, and handing
 * them the successful run they did afterwards to check something would answer
 * a question nobody asked.
 */
async function pickRun(roomId, executionId) {
  if (executionId) {
    const chosen = await Execution.findOne({ roomId, executionId }).lean()
    if (!chosen) throw badRequest('That run is not in this room', 'run_not_found')
    return chosen
  }

  const failed = await Execution.findOne({ roomId, state: { $ne: 'completed' } })
    .sort({ createdAt: -1 })
    .lean()

  return failed ?? (await Execution.findOne({ roomId }).sort({ createdAt: -1 }).lean())
}

const positiveInt = (value, what) => {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) {
    throw badRequest('This action needs ' + what, 'bad_input')
  }
  return number
}

/**
 * Each source: what to call it, and how to read it.
 *
 * `gather` answers `{ detail, text, meta }` — `detail` is the count beside the
 * chip, `text` is what the prompt gets, `meta` is anything the client needs to
 * make the chip useful (a run id to open, a line range to jump to). A source
 * that finds nothing answers `null`, and the run records it as consulted and
 * empty rather than pretending it was never asked.
 */
export const SOURCES = Object.freeze({
  architecture: {
    label: 'Whiteboard architecture',
    async gather({ roomId }) {
      const { shapes } = await readRoomShapes(roomId)
      const graph = extractArchitecture(shapes)
      if (!graph.nodes.length) return null

      return {
        detail: plural(graph.nodes.length, 'component') + ', ' + plural(graph.edges.length, 'connection'),
        text: 'ARCHITECTURE ON THE WHITEBOARD\n' + architectureToPrompt(graph),
        meta: { nodes: graph.nodes.length, edges: graph.edges.length, warnings: graph.warnings.length },
      }
    },
  },

  board: {
    label: 'Whiteboard contents',
    async gather({ roomId }) {
      const { shapes } = await readRoomShapes(roomId)
      if (!shapes.length) return null

      const text = shapes
        .map((shape) => String(shape?.text ?? '').trim())
        .filter(Boolean)
        .slice(0, 120)

      return {
        detail: plural(shapes.length, 'shape'),
        text:
          'WHITEBOARD\n' +
          plural(shapes.length, 'shape') +
          ' drawn.' +
          (text.length ? '\nLabels and notes on it:\n' + text.map((line) => '- ' + line).join('\n') : ''),
        meta: { shapes: shapes.length },
      }
    },
  },

  code: {
    label: 'Shared code buffer',
    async gather({ roomId }) {
      const { code } = await readRoomCode(roomId)
      if (!code.trim()) return null

      const lines = code.split('\n').length
      return {
        detail: plural(lines, 'line'),
        text: 'THE ROOM’S CODE BUFFER\n' + truncate(numbered(code), MAX_CODE),
        meta: { lines, bytes: Buffer.byteLength(code, 'utf8') },
        // The buffer exactly as read, kept off the prompt and off the record.
        // An action that proposes a replacement needs the text it is replacing
        // — captured here rather than read again afterwards, because a second
        // read could pick up a keystroke the model never saw and the whole
        // point of keeping it is that it matches.
        raw: code,
      }
    },
  },

  /**
   * The lines somebody has highlighted, sliced out of the server's own copy.
   *
   * The range travels, the text does not. Sending the text would mean the
   * answer — which is recorded in the room and shown to everyone — could be
   * about anything at all, and would make the prompt an open field rather than
   * a view of the room.
   *
   * Absent rather than refused when nothing is selected. Most actions that
   * read this also read the whole buffer, and narrow to the selection when
   * there is one: "review the code" with nothing highlighted is a request to
   * review the code, not a mistake. The actions that genuinely cannot proceed
   * without a selection say so with `needs`, which the runner checks before
   * anything is read.
   */
  selection: {
    label: 'Your selection',
    async gather({ roomId, input }) {
      if (input?.startLine == null && input?.endLine == null) return null

      const start = positiveInt(input?.startLine, 'a selection in the editor')
      const end = Math.max(start, positiveInt(input?.endLine, 'a selection in the editor'))

      const { code } = await readRoomCode(roomId)
      const lines = code.split('\n')
      if (start > lines.length) {
        throw badRequest('That selection is past the end of the buffer', 'bad_selection')
      }

      const chosen = lines.slice(start - 1, Math.min(end, lines.length))
      if (!chosen.join('').trim()) return null

      return {
        detail: start === end ? 'line ' + start : 'lines ' + start + '–' + Math.min(end, lines.length),
        text:
          'THE SELECTED CODE (lines ' +
          start +
          '–' +
          Math.min(end, lines.length) +
          ' of the room’s buffer)\n' +
          truncate(numbered(chosen.join('\n'), start), MAX_SELECTION),
        meta: { startLine: start, endLine: Math.min(end, lines.length) },
      }
    },
  },

  /**
   * One run, in full.
   *
   * Its output only: a run record keeps a hash of the program, never the
   * program, so this cannot show what was executed. Actions that need to see
   * the code declare `code` alongside — and the prompt says plainly that the
   * buffer may have moved on since, because on a live room it often has.
   */
  run: {
    label: 'The run',
    async gather({ roomId, input }) {
      const run = await pickRun(roomId, input?.executionId)
      if (!run) return null

      return {
        detail: runHeadline(run),
        text:
          'THE RUN\n' +
          runHeadline(run) +
          (run.truncated ? '\n(its output was longer than the room keeps)' : '') +
          '\n' +
          outputOf(run, MAX_OUTPUT) +
          '\n(The room keeps a run’s output, not the program it ran. Any code you were shown is ' +
          'the buffer as it stands now, which may have been edited since this run.)',
        meta: {
          executionId: run.executionId,
          state: run.state,
          exitCode: run.exitCode ?? null,
          language: run.language,
        },
      }
    },
  },

  runs: {
    label: 'Recent runs',
    async gather({ roomId }) {
      const rows = await Execution.find({ roomId })
        .sort({ createdAt: -1 })
        .limit(RECENT_RUNS)
        .lean()

      if (!rows.length) return null

      const failures = rows.filter((row) => row.state !== 'completed').length

      return {
        detail:
          plural(rows.length, 'run') + (failures ? ', ' + failures + ' unsuccessful' : ', all successful'),
        text:
          'RECENT RUNS IN THIS ROOM (newest first)\n' +
          rows
            .map(
              (row, index) =>
                'r' + (index + 1) + '  ' + runHeadline(row) + '\n' + outputOf(row, MAX_BRIEF_OUTPUT)
            )
            .join('\n\n'),
        meta: { count: rows.length, failures, executionIds: rows.map((row) => row.executionId) },
      }
    },
  },

  timeline: {
    label: 'Session history',
    async gather({ roomId }) {
      const timeline = await buildSessionTimeline(roomId)
      if (!timeline.events.length) return null

      const people = [...new Set(timeline.events.map((event) => event.actor).filter(Boolean))]

      return {
        detail: plural(timeline.events.length, 'event'),
        text:
          'SESSION HISTORY\n' +
          'Length ' +
          (timeline.events.at(-1)?.clock ?? '00:00') +
          '. People: ' +
          (people.length ? people.join(', ') : 'unrecorded') +
          '.\n' +
          (timeline.truncated ? 'The history was longer than could be read in full.\n' : '') +
          'Events (id  time  kind  who: what [detail]):\n' +
          timeline.events
            .map(
              (event) =>
                event.id +
                '  ' +
                event.clock +
                '  ' +
                event.kind +
                '  ' +
                (event.actor ? event.actor + ': ' : '') +
                event.text +
                (event.detail ? ' [' + event.detail + ']' : '')
            )
            .join('\n'),
        meta: { events: timeline.events.length, throughSeq: timeline.throughSeq },
        // Kept off the prompt and off the record: run.js uses it to check
        // citations against the events that actually exist.
        timeline,
      }
    },
  },

  moment: {
    label: 'The paused moment',
    async gather({ roomId, input }) {
      const seq = positiveInt(input?.seq, 'a point in the history')
      const timeline = await buildSessionTimeline(roomId)

      if (seq > timeline.throughSeq) {
        throw badRequest('That point is not in this room’s history', 'bad_seq')
      }

      const moment = await momentAt(roomId, seq, timeline)
      const before = timeline.events.filter((event) => event.seq <= seq).slice(-12)
      const clock = before.at(-1)?.clock ?? '00:00'

      return {
        detail: 'at ' + clock,
        text:
          'THE MOMENT THE REPLAY IS PAUSED ON (' +
          clock +
          ', log position ' +
          seq +
          ')\n' +
          'What changed at exactly this point:\n' +
          (moment.changes.length
            ? moment.changes.map((change) => '  - ' + change).join('\n')
            : '  - (no visible change)') +
          (moment.lines.added.length
            ? '\n  Lines added:\n' + moment.lines.added.map((line) => '    + ' + line).join('\n')
            : '') +
          (moment.lines.removed.length
            ? '\n  Lines removed:\n' + moment.lines.removed.map((line) => '    - ' + line).join('\n')
            : ''),
        meta: { seq, clock, changes: moment.changes.length },
      }
    },
  },

  /**
   * Two points in the history, read back and compared.
   *
   * The states come from the replay engine's own checkpointed reads, so what
   * is compared is exactly what the scrubber would show at those two points —
   * an explanation that disagreed with the replay beside it would be worse
   * than no explanation.
   */
  versions: {
    label: 'Two points in the history',
    async gather({ roomId, input }) {
      const to = positiveInt(input?.toSeq ?? input?.seq, 'two points in the history')
      const from = positiveInt(input?.fromSeq, 'two points in the history')
      if (from >= to) throw badRequest('The two points must be in order', 'bad_range')

      const [earlier, later] = await Promise.all([
        snapshotJsonAt(roomId, from),
        snapshotJsonAt(roomId, to),
      ])

      const lines = changedLines(earlier.code, later.code, 60)

      return {
        detail: 'positions ' + from + ' → ' + to,
        text:
          'TWO POINTS IN THE HISTORY, ' +
          from +
          ' then ' +
          to +
          '\n' +
          'Whiteboard: ' +
          earlier.shapes.length +
          ' shapes → ' +
          later.shapes.length +
          ' shapes.\n' +
          'Code: ' +
          earlier.code.split('\n').length +
          ' lines → ' +
          later.code.split('\n').length +
          ' lines.\n' +
          (lines.added.length
            ? 'Lines added:\n' + lines.added.map((line) => '  + ' + line).join('\n') + '\n'
            : '') +
          (lines.removed.length
            ? 'Lines removed:\n' + lines.removed.map((line) => '  - ' + line).join('\n') + '\n'
            : '') +
          (!lines.added.length && !lines.removed.length ? 'The code is unchanged between them.\n' : ''),
        meta: { fromSeq: from, toSeq: to, added: lines.added.length, removed: lines.removed.length },
      }
    },
  },

  comments: {
    label: 'Open comment threads',
    async gather({ roomId }) {
      const threads = await CommentThread.find({ roomId, status: 'open' })
        .sort({ updatedAt: -1 })
        .limit(MAX_THREADS)
        .lean()

      if (!threads.length) return null

      return {
        detail: plural(threads.length, 'open thread'),
        text:
          'OPEN COMMENT THREADS (unresolved conversations attached to the work)\n' +
          threads
            .map((thread, index) => {
              const messages = (thread.messages ?? []).filter((message) => !message.deletedAt)
              const first = messages[0]
              return (
                'c' +
                (index + 1) +
                '  on ' +
                (thread.anchor?.kind ?? 'the room') +
                (thread.anchor?.label ? ' "' + thread.anchor.label + '"' : '') +
                (thread.anchor?.line ? ' line ' + thread.anchor.line : '') +
                '  ' +
                (first?.authorName ?? 'someone') +
                ': ' +
                truncate(String(first?.body ?? '').replace(/\s+/g, ' '), 300) +
                (messages.length > 1 ? '  (' + plural(messages.length - 1, 'reply', 'replies') + ')' : '')
              )
            })
            .join('\n'),
        meta: { threads: threads.length },
      }
    },
  },

  files: {
    label: 'Files in the room',
    async gather({ roomId }) {
      const rows = await File.find({ roomId })
        .select({ originalName: 1, size: 1, mimeType: 1, createdAt: 1 })
        .sort({ createdAt: -1 })
        .limit(MAX_FILES)
        .lean()

      if (!rows.length) return null

      return {
        detail: plural(rows.length, 'file'),
        // Names and sizes only. Reading every file into the prompt would be a
        // different feature with a different cost, and none of the actions
        // that declare this source need the contents to answer.
        text:
          'FILES SHARED IN THIS ROOM (names only — you have not been shown their contents)\n' +
          rows.map((row) => '- ' + row.originalName + ' (' + row.size + ' bytes)').join('\n'),
        meta: { files: rows.length },
      }
    },
  },
})

export const SOURCE_KEYS = Object.freeze(Object.keys(SOURCES))

/**
 * Reads everything an action declared, in parallel, and reports each one.
 *
 * A source that throws is fatal — "this action needs a selection" is a real
 * answer and refusing is better than answering about the wrong thing. A source
 * that finds nothing is not: a room with no runs yet still has a session
 * history worth summarising, and the empty chip tells the reader the copilot
 * looked.
 */
export async function gatherSources(keys, context) {
  const gathered = await Promise.all(
    keys.map(async (key) => {
      const source = SOURCES[key]
      if (!source) throw new Error('Unknown copilot source: ' + key)

      const found = await source.gather(context)
      return {
        key,
        label: source.label,
        detail: found?.detail ?? 'nothing recorded yet',
        present: Boolean(found),
        meta: found?.meta ?? {},
        text: found?.text ?? null,
        // Neither of these is shown or stored. `timeline` lets the runner
        // check citations against events that exist; `raw` lets it keep the
        // text a proposed patch was written against.
        timeline: found?.timeline ?? null,
        raw: found?.raw ?? null,
      }
    })
  )

  return gathered
}

/** What the client is shown: labels and counts, never the material itself. */
export const describeSources = (sources) =>
  sources.map(({ key, label, detail, present, meta }) => ({ key, label, detail, present, meta }))
