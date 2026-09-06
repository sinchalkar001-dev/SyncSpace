import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { unavailable, upstream } from '../errors.js'
import { architectureToPrompt } from './architecture.service.js'
import { providerNamed, resolveProvider } from './ai.providers.js'

/**
 * Turning an architecture graph into a proposed implementation.
 *
 * Two things are deliberate here.
 *
 * The model never sees the whiteboard. It sees the graph that
 * architecture.service.js recovered from it — components, connections, and an
 * explicit list of what the diagram failed to say. A screenshot would make
 * this a vision problem with no way to tell "there is no arrow here" from "I
 * did not notice the arrow", and no way for the user to correct the reading
 * before spending a request on it.
 *
 * And nothing it returns is trusted. Everything below `askForImplementation`
 * exists to make sure a confident answer cannot write outside the room, blow
 * up the database, or claim to modify a file it was never shown.
 */

/** What can be asked for. Each is a section of the prompt, not a mode. */
export const TARGETS = {
  backend: 'Server-side services and business logic',
  api: 'HTTP route handlers, request validation and error handling',
  database: 'Data models, schemas, indexes and migrations',
  frontend: 'Client scaffolding: pages, components and data fetching',
}

export const TARGET_KEYS = Object.keys(TARGETS)

/** Caps on what will be accepted back, whatever the model produces. */
const MAX_FILES = 40
const MAX_FILE_BYTES = 120_000
const MAX_TOTAL_BYTES = 600_000
const MAX_PATH_LENGTH = 180
const MAX_LIST_ITEMS = 30
const MAX_TEXT = 2_000

/**
 * Whether this deployment can generate at all, and why not when it cannot.
 *
 * Shaped like `/runners`: the UI asks first and explains, rather than
 * offering a button that fails. A missing key is a deployment choice, not an
 * error, so it is reported the same way a missing compiler is.
 */
export function aiStatus() {
  if (!env.AI_ENABLED) {
    return {
      enabled: false,
      model: null,
      provider: null,
      reason: 'Code generation is switched off on this server.',
    }
  }

  const { key, provider } = resolveProvider()

  if (!key) {
    return {
      enabled: false,
      model: null,
      provider: null,
      reason:
        'No model key is configured, so this server cannot reach a model. ' +
        'Set ANTHROPIC_API_KEY or GOOGLE_API_KEY.',
    }
  }

  const vendor = providerNamed(provider)
  if (!vendor) {
    // A key of an unrecognised shape is reported rather than guessed at: a
    // wrong guess means a 401 from a service the key was never issued for.
    return {
      enabled: false,
      model: null,
      provider: null,
      reason:
        'The configured key is not recognisably an Anthropic (sk-ant-…) or Google (AIza… or AQ.…) ' +
        'key. Set AI_PROVIDER to say which service to call.',
    }
  }

  return {
    enabled: true,
    provider: vendor.name,
    model: env.AI_MODEL ?? vendor.defaultModel,
    reason: null,
  }
}

const SYSTEM_PROMPT = [
  'You are a staff engineer turning a hand-drawn architecture diagram into a first implementation.',
  '',
  'You are given a graph that was recovered from a collaborative whiteboard: the components',
  'someone drew, the connections between them, any notes, and — importantly — a list of things',
  'the diagram could not express. You are NOT given the existing codebase.',
  '',
  'Rules:',
  '- Propose whole files. Someone will review each one before anything is written.',
  '- Use relative paths only. Never an absolute path, a parent reference, or a path outside the',
  '  project.',
  '- Only propose deleting a file if the diagram makes it genuinely redundant, and say why.',
  '- Where the diagram is silent, choose a sensible default and RECORD IT as an assumption.',
  '  Do not present a guess as though the diagram said it.',
  '- Where a choice would materially change the design and you cannot make it safely, ask a',
  '  question instead of guessing. Missing information is a real answer.',
  '- Prefer a small, coherent, runnable skeleton over breadth. Working stubs beat forty empty files.',
  '- Write code that would pass review: real error handling, no placeholder secrets, no TODO that',
  '  hides a decision you should have surfaced as a question.',
].join('\n')

/**
 * The JSON shape the answer must take.
 *
 * Sent as a tool definition and forced with `tool_choice`, rather than asking
 * for JSON in prose and parsing whatever comes back. A model asked politely
 * for JSON will occasionally wrap it in commentary or a code fence, and every
 * one of those is a failed generation the user paid for.
 */
const PROPOSAL_TOOL = {
  name: 'propose_implementation',
  description: 'Return the implementation plan and the files that make it up.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'One paragraph: what this system is and what is being built.',
      },
      plan: {
        type: 'array',
        description: 'Ordered steps a person would follow to build this.',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string' },
            detail: { type: 'string' },
          },
          required: ['step'],
        },
      },
      files: {
        type: 'array',
        description: 'The proposed change set.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path, e.g. src/services/auth.js' },
            action: { type: 'string', enum: ['create', 'modify', 'delete'] },
            language: { type: 'string' },
            contents: { type: 'string', description: 'The whole file. Omit for a delete.' },
            rationale: { type: 'string', description: 'Why this file exists, in one sentence.' },
          },
          required: ['path', 'action'],
        },
      },
      assumptions: {
        type: 'array',
        description: 'Decisions you made that the diagram did not specify.',
        items: { type: 'string' },
      },
      questions: {
        type: 'array',
        description: 'What is missing from the diagram that a person needs to answer.',
        items: { type: 'string' },
      },
    },
    required: ['summary', 'plan', 'files', 'assumptions', 'questions'],
  },
}

function buildUserPrompt({ architecture, targets, intent }) {
  const wanted = targets.map((key) => '- ' + key + ': ' + TARGETS[key]).join('\n')

  return [
    'Here is the architecture recovered from the whiteboard.',
    '',
    architectureToPrompt(architecture),
    '',
    'GENERATE',
    wanted,
    '',
    intent ? 'ADDITIONAL INSTRUCTIONS FROM THE PERSON WHO DREW IT\n' + intent : '',
    '',
    'Return your answer with the propose_implementation tool.',
  ]
    .filter(Boolean)
    .join('\n')
}

const clampText = (value, limit = MAX_TEXT) =>
  typeof value === 'string' ? value.trim().slice(0, limit) : ''

const clampList = (value, limit = MAX_LIST_ITEMS) =>
  (Array.isArray(value) ? value : [])
    .map((item) => clampText(item))
    .filter(Boolean)
    .slice(0, limit)

/**
 * Whether a proposed path is one this server is willing to name.
 *
 * The path is chosen by a model and is about to be shown as a file to create.
 * It never reaches the filesystem directly — applying goes through the upload
 * service, which generates its own stored name — but it is displayed, stored,
 * and compared against real filenames, and a path that escapes the project is
 * a lie in all three places. Refused rather than repaired, because silently
 * rewriting "../../etc/passwd" into something harmless would hide that the
 * model tried.
 */
export function isSafePath(path) {
  if (typeof path !== 'string') return false
  const value = path.trim()

  if (!value || value.length > MAX_PATH_LENGTH) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  // Windows drive letters and UNC paths are absolute too.
  if (/^[a-zA-Z]:/.test(value) || value.startsWith('\\\\')) return false
  if (value.includes('\\')) return false
  if (value.split('/').some((segment) => segment === '..' || segment === '.')) return false
  if (value.includes('\0')) return false
  // A trailing slash is a directory, and a directory is not a file.
  if (value.endsWith('/')) return false

  return true
}

/**
 * Takes what the model returned and keeps only what is usable.
 *
 * Refusals are collected rather than thrown: one bad path out of thirty files
 * should cost that file and a line explaining it, not the whole generation
 * the user just waited for.
 */
export function sanitiseProposal(raw) {
  const rejected = []
  const seen = new Set()
  const files = []
  let totalBytes = 0

  for (const candidate of Array.isArray(raw?.files) ? raw.files : []) {
    if (files.length >= MAX_FILES) {
      rejected.push('More than ' + MAX_FILES + ' files were proposed; the rest were dropped.')
      break
    }

    const path = typeof candidate?.path === 'string' ? candidate.path.trim() : ''
    const action = candidate?.action

    if (!isSafePath(path)) {
      rejected.push('Refused a file with an unusable path: ' + JSON.stringify(path).slice(0, 80))
      continue
    }
    if (action !== 'create' && action !== 'modify' && action !== 'delete') {
      rejected.push('Refused "' + path + '": unknown action ' + JSON.stringify(action))
      continue
    }
    if (seen.has(path)) {
      rejected.push('Refused a second entry for "' + path + '".')
      continue
    }

    const contents = action === 'delete' ? '' : String(candidate?.contents ?? '')

    if (action !== 'delete' && !contents.trim()) {
      rejected.push('Refused "' + path + '": no contents were provided.')
      continue
    }

    const bytes = Buffer.byteLength(contents, 'utf8')
    if (bytes > MAX_FILE_BYTES) {
      rejected.push('Refused "' + path + '": ' + bytes + ' bytes is larger than one file may be.')
      continue
    }
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      rejected.push('Refused "' + path + '": the change set had already reached its size limit.')
      continue
    }

    seen.add(path)
    totalBytes += bytes
    files.push({
      path,
      action,
      language: clampText(candidate?.language, 40) || null,
      contents,
      rationale: clampText(candidate?.rationale, 400) || null,
      size: bytes,
    })
  }

  const plan = (Array.isArray(raw?.plan) ? raw.plan : [])
    .map((item) => ({
      step: clampText(item?.step, 200),
      detail: clampText(item?.detail, 800) || null,
    }))
    .filter((item) => item.step)
    .slice(0, MAX_LIST_ITEMS)

  return {
    summary: clampText(raw?.summary, 4000),
    plan,
    files,
    assumptions: clampList(raw?.assumptions),
    questions: clampList(raw?.questions),
    rejected,
  }
}

/**
 * Calls the model and returns a sanitised proposal.
 *
 * The timeout is enforced here rather than left to the platform: a generation
 * holds an HTTP request open, and a request that never settles is worse than
 * one that fails, because the person is left watching a spinner with nothing
 * to press.
 */
export async function askForImplementation({ architecture, targets, intent, model }) {
  const status = aiStatus()
  if (!status.enabled) throw unavailable(status.reason, 'ai_disabled')

  const { key } = resolveProvider()
  const vendor = providerNamed(status.provider)

  const call = vendor.request({
    baseUrl: env.AI_BASE_URL ?? vendor.defaultBaseUrl,
    key,
    model: model || status.model,
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt({ architecture, targets, intent }),
    tool: PROPOSAL_TOOL,
    maxTokens: env.AI_MAX_OUTPUT_TOKENS,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), env.AI_TIMEOUT_MS)

  let response
  try {
    response = await fetch(call.url, {
      method: 'POST',
      signal: controller.signal,
      headers: call.headers,
      body: JSON.stringify(call.body),
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw upstream('The model did not answer in time. Try a smaller diagram.', 'ai_timeout')
    }
    // The message can carry the host and, on some failures, the request
    // headers; only the class is logged and nothing of it reaches the client.
    logger.error({ code: error?.code ?? error?.name }, 'AI request failed to send')
    throw upstream('Could not reach the model.', 'ai_unreachable')
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    // Read the body for the log, never for the response: provider errors
    // quote request fields back, and the API key travels in a header that
    // some gateways echo.
    const detail = await response.text().catch(() => '')
    logger.error(
      { status: response.status, detail: detail.slice(0, 500) },
      'AI request was refused'
    )
    /**
     * "Refused" is the wrong word for most of these, and the wrong word sends
     * somebody looking for a fault in their diagram.
     *
     * 429 and 503 are both temporary and both mean try again — 503 especially,
     * which is the provider being busy and has nothing to do with the request.
     * 401 and 403 mean the key, which is a different job entirely. Only what
     * is left is genuinely a refusal.
     */
    const temporary = response.status === 429 || response.status === 503
    const credential = response.status === 401 || response.status === 403

    throw upstream(
      temporary
        ? response.status === 429
          ? 'The model is rate limiting this server. Try again shortly.'
          : 'The model is busy right now. Try again in a moment.'
        : credential
          ? 'The model rejected this server\'s API key (HTTP ' + response.status + ').'
          : 'The model refused the request (HTTP ' + response.status + ').',
      temporary ? 'ai_unavailable' : credential ? 'ai_bad_key' : 'ai_failed'
    )
  }

  const payload = await response.json().catch(() => null)
  const answer = vendor.parse(payload, PROPOSAL_TOOL.name)

  if (!answer.input) {
    logger.error(
      { provider: vendor.name, stop: answer.stopReason },
      'AI answered without using the proposal tool'
    )
    throw upstream(
      answer.stopReason === 'max_tokens'
        ? 'The answer was cut off before it was complete. Try fewer targets at once.'
        : 'The model did not answer in the expected shape.',
      'ai_malformed'
    )
  }

  return {
    proposal: sanitiseProposal(answer.input),
    model: answer.model ?? model ?? status.model,
    provider: vendor.name,
    usage: answer.usage,
  }
}
