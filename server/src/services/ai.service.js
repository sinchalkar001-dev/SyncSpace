import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { unavailable, upstream } from '../errors.js'
import { providerNamed, resolveProvider } from './ai.providers.js'
import { createEventStreamParser, partialString } from '../utils/partial-json.js'

/**
 * Talking to a model, and not believing what comes back.
 *
 * Everything here is shared by the features that ask a model something — the
 * copilot and the session summaries. Two things are deliberate.
 *
 * Every answer is a forced tool call rather than prose asked politely for
 * JSON. A model that wraps its answer in a code fence once a day is a failed
 * request somebody paid for, and `ai.providers.js` makes both vendors answer
 * the same structured way so nothing downstream has to know which one replied.
 *
 * And nothing an answer contains is trusted. `sanitiseFiles` is the sharpest
 * edge of that: a list of paths and contents produced by something that has
 * never seen this codebase is a list of instructions, and it is displayed,
 * stored, compared against real filenames and eventually written.
 */

/** Caps on what will be accepted back, whatever the model produces. */
const MAX_FILES = 40
const MAX_FILE_BYTES = 120_000
const MAX_TOTAL_BYTES = 600_000
const MAX_PATH_LENGTH = 180
const MAX_LIST_ITEMS = 30
const MAX_TEXT = 2_000

/**
 * Whether this deployment can reach a model at all, and why not when it cannot.
 *
 * Shaped like `/runners`: the interface asks first and explains, rather than
 * offering a button that fails. A missing key is a deployment choice, not an
 * error, so it is reported the same way a missing compiler is.
 */
export function aiStatus() {
  if (!env.AI_ENABLED) {
    return {
      enabled: false,
      model: null,
      provider: null,
      reason: 'AI features are switched off on this server.',
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

export const clampText = (value, limit = MAX_TEXT) =>
  typeof value === 'string' ? value.trim().slice(0, limit) : ''

export const clampList = (value, limit = MAX_LIST_ITEMS) =>
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
 * Keeps the proposed files that are usable, and says why the rest went.
 *
 * A file list produced by a model is a list of paths and contents about to be
 * written somewhere, which is to say a list of instructions. There is one
 * place that decides what is allowed, and this is it — a second copy for the
 * next feature is how one of them ends up with the weaker rules.
 *
 * Refusals are collected rather than thrown: one bad path out of thirty files
 * should cost that file and a line explaining it, not the whole answer the
 * user just waited for.
 */
export function sanitiseFiles(raw) {
  const rejected = []
  const seen = new Set()
  const files = []
  let totalBytes = 0

  for (const candidate of Array.isArray(raw) ? raw : []) {
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

  return { files, rejected }
}

/**
 * The one place a model request is prepared, so the streaming path and the
 * plain one cannot drift on which key, which model, or which timeout.
 */
function prepare({ system, prompt, tool, maxTokens, model }) {
  const status = aiStatus()
  if (!status.enabled) throw unavailable(status.reason, 'ai_disabled')

  const { key } = resolveProvider()
  const vendor = providerNamed(status.provider)

  return {
    vendor,
    status,
    options: {
      baseUrl: env.AI_BASE_URL ?? vendor.defaultBaseUrl,
      key,
      model: model || status.model,
      system,
      prompt,
      tool,
      maxTokens: maxTokens ?? env.AI_MAX_OUTPUT_TOKENS,
    },
  }
}

/** Sends a prepared call once, or explains why it could not be sent. */
async function sendOnce(call, hints) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), env.AI_TIMEOUT_MS)

  try {
    return await fetch(call.url, {
      method: 'POST',
      signal: controller.signal,
      headers: call.headers,
      body: JSON.stringify(call.body),
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw upstream(hints.timeout ?? 'The model did not answer in time.', 'ai_timeout')
    }
    // The message can carry the host and, on some failures, the request
    // headers; only the class is logged and nothing of it reaches the client.
    logger.error({ code: error?.code ?? error?.name }, 'AI request failed to send')
    throw upstream('Could not reach the model.', 'ai_unreachable')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The two answers that mean "not now" rather than "no".
 *
 * A 503 is the provider being busy and has nothing to do with the request; a
 * 429 is this server being asked to slow down. Neither produced an answer, so
 * asking again costs nothing but the wait.
 */
const RETRY_STATUS = new Set([429, 503])

/** How long to wait before each further attempt. Two, then stop. */
const RETRY_BACKOFF_MS = [700, 2100]

/**
 * A provider asking for longer than this is taken at its word and not waited
 * out: somebody is standing in front of a button, and "try again shortly" is
 * a better answer than a request that hangs for a minute first.
 */
const MAX_RETRY_WAIT_MS = 5000

/** What `Retry-After` asks for, in milliseconds — seconds or a date. */
function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after')
  if (!header) return null

  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds * 1000

  const at = Date.parse(header)
  return Number.isFinite(at) ? at - Date.now() : null
}

/** Waits, and stops waiting if whoever asked has gone away. */
function pauseFor(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

/**
 * Sends a prepared call, asking again when the provider says "not now".
 *
 * Without this, one busy moment at the provider became "The model is busy
 * right now" in front of the person who had just pressed the button — for a
 * request the provider never answered, on a model that would have answered a
 * second later. Retrying here rather than in each caller means the copilot,
 * the session summaries and the streaming path all get it.
 *
 * Only these two statuses, and only a refusal: a timeout means the model *is*
 * working and asking again would both double the wait and pay twice.
 */
async function send(call, hints, signal) {
  let response = await sendOnce(call, hints)

  for (const backoff of RETRY_BACKOFF_MS) {
    if (response.ok || !RETRY_STATUS.has(response.status) || signal?.aborted) return response

    const asked = retryAfterMs(response)
    if (asked !== null && asked > MAX_RETRY_WAIT_MS) return response

    const pause = Math.max(asked ?? backoff, 0)
    logger.warn({ status: response.status, pause }, 'the model was busy; asking again')

    // Nothing has read this body and nothing will; let the connection go.
    response.body?.cancel?.()?.catch?.(() => {})
    await pauseFor(pause, signal)

    response = await sendOnce(call, hints)
  }

  return response
}

/**
 * Turns a refused response into something worth reading.
 *
 * "Refused" is the wrong word for most of these, and the wrong word sends
 * somebody looking for a fault in their own input.
 *
 * 429 and 503 are both temporary and both mean try again - 503 especially,
 * which is the provider being busy and has nothing to do with the request.
 * 401 and 403 mean the key, which is a different job entirely. Only what is
 * left is genuinely a refusal.
 */
async function refused(response) {
  // Read the body for the log, never for the response: provider errors quote
  // request fields back, and the API key travels in a header that some
  // gateways echo.
  const detail = await response.text().catch(() => '')
  logger.error({ status: response.status, detail: detail.slice(0, 500) }, 'AI request was refused')

  const temporary = response.status === 429 || response.status === 503
  const credential = response.status === 401 || response.status === 403

  return upstream(
    temporary
      ? response.status === 429
        ? 'The model is rate limiting this server. Try again shortly.'
        : 'The model is busy right now. Try again in a moment.'
      : credential
        ? "The model rejected this server's API key (HTTP " + response.status + ').'
        : 'The model refused the request (HTTP ' + response.status + ').',
    temporary ? 'ai_unavailable' : credential ? 'ai_bad_key' : 'ai_failed'
  )
}

/** The failure when an answer arrives in a shape nothing can read. */
function malformed({ provider, stopReason, tool, hints }) {
  logger.error({ provider, stop: stopReason, tool }, 'AI answered without using the required tool')

  return upstream(
    stopReason === 'max_tokens'
      ? (hints.cutoff ?? 'The answer was cut off before it was complete.')
      : 'The model did not answer in the expected shape.',
    'ai_malformed'
  )
}

export async function callModelTool({ system, prompt, tool, maxTokens, model, hints = {} }) {
  const { vendor, status, options } = prepare({ system, prompt, tool, maxTokens, model })

  const response = await send(vendor.request(options), hints)
  if (!response.ok) throw await refused(response)

  const payload = await response.json().catch(() => null)
  const answer = vendor.parse(payload, tool.name)

  if (!answer.input) {
    throw malformed({
      provider: vendor.name,
      stopReason: answer.stopReason,
      tool: tool.name,
      hints,
    })
  }

  return {
    input: answer.input,
    model: answer.model ?? model ?? status.model,
    provider: vendor.name,
    usage: answer.usage,
  }
}

/**
 * The same call, with the answer's prose delivered as it is written.
 *
 * `onDelta` is handed each new piece of `streamField` — the difference since
 * the last call, never the whole thing again, because the caller is forwarding
 * it to a browser and cannot take anything back. The complete, parsed
 * arguments are still what the return value carries: streaming is for the
 * reader, and nothing downstream is built from a fragment.
 *
 * A provider with no streaming support is not an error. The answer arrives
 * whole, `onDelta` is called once with all of it, and `streamed: false` in the
 * result says which of the two happened — a deployment on Google should be
 * able to tell "this model does not stream" from "streaming is broken".
 */
export async function streamModelTool({
  system,
  prompt,
  tool,
  maxTokens,
  model,
  hints = {},
  streamField,
  onDelta,
  signal,
}) {
  const { vendor, status, options } = prepare({ system, prompt, tool, maxTokens, model })

  if (!vendor.stream) {
    const answer = await callModelTool({ system, prompt, tool, maxTokens, model, hints })
    const whole = typeof answer.input?.[streamField] === 'string' ? answer.input[streamField] : ''
    if (whole) onDelta?.(whole)
    return { ...answer, streamed: false }
  }

  const response = await send(vendor.stream.request(options), hints, signal)
  if (!response.ok) throw await refused(response)

  const parser = createEventStreamParser()
  const decoder = new TextDecoder()
  const reader = response.body.getReader()

  let raw = ''
  let sent = 0
  let stopReason = null
  let answeredBy = null
  let usage = { inputTokens: null, outputTokens: null }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      // Someone closed the browser tab. Nothing downstream is waiting for
      // this, and the provider is charging for every token still coming.
      if (signal?.aborted) {
        await reader.cancel().catch(() => {})
        throw upstream('The request was cancelled.', 'ai_cancelled')
      }

      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        if (frame.data === '[DONE]') continue

        let data
        try {
          data = JSON.parse(frame.data)
        } catch {
          // A frame that is not JSON is a frame this code does not understand,
          // not a reason to throw away an answer that is otherwise arriving.
          continue
        }

        const seen = vendor.stream.event({ event: frame.event, data })
        if (!seen) continue

        if (seen.error) {
          throw upstream('The model stopped part way through the answer.', 'ai_failed')
        }
        if (seen.model) answeredBy = seen.model
        if (seen.stopReason) stopReason = seen.stopReason
        if (seen.usage) usage = { ...usage, ...seen.usage }

        if (typeof seen.partial === 'string' && seen.partial) {
          raw += seen.partial

          const field = partialString(raw, streamField)
          if (field.found && field.value.length > sent) {
            onDelta?.(field.value.slice(sent))
            sent = field.value.length
          }
        }
      }
    }
  } finally {
    reader.releaseLock?.()
  }

  let input = null
  try {
    input = raw ? JSON.parse(raw) : null
  } catch {
    input = null
  }

  if (!input) {
    throw malformed({ provider: vendor.name, stopReason, tool: tool.name, hints })
  }

  return {
    input,
    model: answeredBy ?? model ?? status.model,
    provider: vendor.name,
    usage,
    streamed: true,
  }
}
