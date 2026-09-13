import { clampText, sanitiseFiles } from '../ai.service.js'

/**
 * The pieces an answer can be made of.
 *
 * This is the half of the framework that stops "add an AI button" from meaning
 * "write another service". An action does not describe the JSON it wants back;
 * it names the blocks it produces, and the schema, the sanitising and the
 * rendering all follow from that. Twenty-three actions share eleven blocks, so
 * a new one is a line in the registry rather than a new shape to validate, a
 * new thing the client has to learn to draw, and a new place for a model to put
 * something nobody checked.
 *
 * Every block sanitises. Nothing here trusts a field to be the type it was
 * asked for, a list to be short, or a string to be a string — this is the
 * boundary between "the model returned something odd" and "the model was
 * believed". The rule is the same as everywhere else in this codebase: clamp
 * and drop, never throw, because one malformed finding should cost that
 * finding and not the answer somebody waited thirty seconds for.
 */

const MAX_ITEMS = 12
const MAX_TITLE = 160
const MAX_DETAIL = 1200
const MAX_ANSWER = 6000
const MAX_EVIDENCE = 6

const SEVERITIES = ['high', 'medium', 'low']
const SIZES = ['small', 'medium', 'large']

/** A value from a fixed set, or the fallback. Never the model's own invention. */
const oneOf = (value, allowed, fallback) =>
  allowed.includes(String(value ?? '').toLowerCase()) ? String(value).toLowerCase() : fallback

const list = (value, limit = MAX_ITEMS) => (Array.isArray(value) ? value.slice(0, limit) : [])

const strings = (value, limit = MAX_ITEMS, max = 400) =>
  list(value, limit)
    .map((item) => clampText(item, max))
    .filter(Boolean)

/**
 * Where a statement points in the room.
 *
 * Free text on purpose — "line 42", "the auth service node", "run 3" — because
 * it is shown beside the statement rather than resolved into a link. A
 * structured reference would have to be checked against the room to be worth
 * anything, and a reference that silently fails to resolve is worse than a
 * phrase a person can read.
 */
const evidence = (value) => strings(value, MAX_EVIDENCE, 200)

/**
 * Every block: the schema fragment the model is shown, and the function that
 * decides what survives contact with it.
 *
 * `required` says whether an action producing this block must have it. Only
 * `answer` is: an action that returns findings and finds none is a legitimate
 * answer, and forcing the field would invite a padded one.
 */
export const BLOCKS = Object.freeze({
  /**
   * The reply in prose, and the only block that streams.
   *
   * First in every schema deliberately. Models emit tool arguments in the
   * order the schema declares them, so putting the prose first is what makes
   * a copilot that types rather than one that sits still for twenty seconds
   * and then appears all at once.
   */
  answer: {
    required: true,
    property: {
      type: 'string',
      description:
        'The reply itself, in plain prose. Two or three short paragraphs at most. ' +
        'Lead with the answer, not with a restatement of the question.',
    },
    sanitise: (raw) => clampText(raw, MAX_ANSWER),
  },

  findings: {
    property: {
      type: 'array',
      description:
        'Specific things found. Empty is a real answer — do not invent a finding to fill the list.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'One line: what is wrong or notable.' },
          detail: { type: 'string', description: 'Why it matters and what to do about it.' },
          severity: { type: 'string', enum: SEVERITIES },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description: 'Where in the material shown to you this rests — a line, a node, a run.',
          },
        },
        required: ['title', 'severity'],
      },
    },
    sanitise: (raw) =>
      list(raw)
        .map((item) => ({
          title: clampText(item?.title, MAX_TITLE),
          detail: clampText(item?.detail, MAX_DETAIL) || null,
          severity: oneOf(item?.severity, SEVERITIES, 'medium'),
          evidence: evidence(item?.evidence),
        }))
        .filter((item) => item.title),
  },

  steps: {
    property: {
      type: 'array',
      description: 'Ordered steps someone would actually follow.',
      items: {
        type: 'object',
        properties: {
          step: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['step'],
      },
    },
    sanitise: (raw) =>
      list(raw)
        .map((item) => ({
          step: clampText(item?.step, MAX_TITLE),
          detail: clampText(item?.detail, MAX_DETAIL) || null,
        }))
        .filter((item) => item.step),
  },

  tasks: {
    property: {
      type: 'array',
      description: 'Work items, each small enough for one person to pick up.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          size: { type: 'string', enum: SIZES },
          blockedBy: { type: 'string', description: 'What must happen first, if anything.' },
        },
        required: ['title'],
      },
    },
    sanitise: (raw) =>
      list(raw)
        .map((item) => ({
          title: clampText(item?.title, MAX_TITLE),
          detail: clampText(item?.detail, MAX_DETAIL) || null,
          size: oneOf(item?.size, SIZES, 'medium'),
          blockedBy: clampText(item?.blockedBy, 200) || null,
        }))
        .filter((item) => item.title),
  },

  /**
   * A side-by-side reading of two things.
   *
   * Rows rather than prose because comparison is the one shape where prose
   * reliably hides the thing being compared — "the second run was faster" is
   * an assertion, two numbers in a row are evidence.
   */
  comparison: {
    property: {
      type: 'array',
      description: 'One row per thing that differs. Leave out what is identical.',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'What is being compared, e.g. "exit code".' },
          before: { type: 'string' },
          after: { type: 'string' },
          note: { type: 'string', description: 'What the difference means, if anything.' },
        },
        required: ['subject'],
      },
    },
    sanitise: (raw) =>
      list(raw)
        .map((item) => ({
          subject: clampText(item?.subject, MAX_TITLE),
          before: clampText(item?.before, 400),
          after: clampText(item?.after, 400),
          note: clampText(item?.note, 600) || null,
        }))
        .filter((item) => item.subject),
  },

  /**
   * Whole files, for a change set that goes through review before anything is
   * written. Sanitised by ai.service.js, which owns the path rules — the same
   * check that guards "generate from whiteboard".
   */
  files: {
    property: {
      type: 'array',
      description:
        'Whole files. Relative paths only. Someone reviews each one before anything is written.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path, e.g. src/services/auth.js' },
          action: { type: 'string', enum: ['create', 'modify', 'delete'] },
          language: { type: 'string' },
          contents: { type: 'string', description: 'The whole file. Omit for a delete.' },
          rationale: { type: 'string' },
        },
        required: ['path', 'action'],
      },
    },
    sanitise: (raw) => sanitiseFiles(raw),
  },

  /**
   * A replacement for the shared code buffer.
   *
   * The whole buffer, not a diff. A model producing a unified diff against a
   * document three people are editing is a merge conflict waiting for someone
   * to press a button — whereas a whole replacement can be checked against the
   * text it was written from before it is allowed anywhere near the document.
   * See copilot/apply.js: the buffer must still be what the model was shown,
   * or the patch is refused rather than applied over the difference.
   */
  patch: {
    property: {
      type: 'object',
      description:
        'The complete revised contents of the code buffer. Only when you are proposing a change ' +
        'to the code you were shown — otherwise leave this out entirely.',
      properties: {
        contents: { type: 'string', description: 'The whole buffer as it should read afterwards.' },
        rationale: { type: 'string', description: 'What changed, in one or two sentences.' },
      },
      required: ['contents'],
    },
    sanitise: (raw) => {
      const contents = typeof raw?.contents === 'string' ? raw.contents : ''
      if (!contents.trim()) return null
      return {
        contents: contents.slice(0, 200_000),
        rationale: clampText(raw?.rationale, 600) || null,
      }
    },
  },

  questions: {
    property: {
      type: 'array',
      description: 'What you would need answered to be more certain. Empty is fine.',
      items: { type: 'string' },
    },
    sanitise: (raw) => strings(raw),
  },

  assumptions: {
    property: {
      type: 'array',
      description: 'What you assumed because the material did not say.',
      items: { type: 'string' },
    },
    sanitise: (raw) => strings(raw),
  },

  /**
   * Event ids from a session timeline, checked against the timeline rather
   * than believed. Only the replay actions produce this; the grounding itself
   * lives in run.js, which is the only place that has the timeline to hand.
   */
  citations: {
    property: {
      type: 'array',
      description:
        'Ids of the timeline events this rests on, such as "e12". Cite only ids you were given.',
      items: { type: 'string' },
    },
    sanitise: (raw) => strings(raw, MAX_ITEMS, 16),
  },
})

export const BLOCK_NAMES = Object.freeze(Object.keys(BLOCKS))

/** The field whose value is streamed to the client as it arrives. */
export const STREAM_FIELD = 'answer'

/**
 * The tool an action is forced to call, built from the blocks it produces.
 *
 * One forced tool call rather than a request for JSON in prose, for the reason
 * ai.providers.js gives: a model that wraps its answer in a code fence once a
 * day is a failed request somebody paid for.
 */
export function toolFor(action) {
  const properties = {}
  const required = []

  for (const name of action.produces) {
    const block = BLOCKS[name]
    if (!block) throw new Error('Unknown copilot block: ' + name)
    properties[name] = block.property
    if (block.required) required.push(name)
  }

  return {
    name: 'answer_' + action.id.replace(/[^a-z0-9]+/gi, '_'),
    description: action.title + '. ' + action.detail,
    input_schema: { type: 'object', properties, required },
  }
}

/**
 * What survives of the model's answer.
 *
 * Blocks the action did not ask for are dropped rather than kept: a model that
 * volunteers a `patch` for an action with no way to apply one has produced
 * something nobody would ever review, and carrying it would mean every
 * consumer has to remember that a field being present does not mean it is
 * offered.
 */
export function sanitiseResult(action, raw) {
  const result = {}
  const rejected = []

  for (const name of action.produces) {
    const value = BLOCKS[name].sanitise(raw?.[name])

    // The files block answers with its own refusals alongside the files, so
    // the reasons reach the person instead of the count quietly shrinking.
    if (name === 'files') {
      result.files = value.files
      rejected.push(...value.rejected)
      continue
    }

    result[name] = value
  }

  return { result, rejected }
}
