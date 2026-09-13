/**
 * Reading one string field out of JSON that has not finished arriving.
 *
 * The copilot's answers come back as a forced tool call, which is what stops a
 * model wrapping them in a code fence — but it also means the prose arrives as
 * a JSON string being assembled a fragment at a time, and `{"answer": "The ret`
 * is not JSON and never will be until the end. Waiting for the closing brace
 * would mean a copilot that sits still for twenty seconds and then appears all
 * at once, which is a worse product than a slower one that types.
 *
 * So this reads the field out of the fragment. It is deliberately not a JSON
 * parser: it finds one key, decodes its value as far as the buffer goes, and
 * says whether that value has ended. Everything else in the object is ignored
 * until the whole thing parses properly at the end, which is what the result
 * is actually built from — this is only for the typing.
 *
 * The one rule that matters: never emit a half-decoded escape. A buffer ending
 * mid-`\uD83D` must hold that back rather than show its pieces, because the
 * caller streams the difference between calls and cannot take anything back.
 */

const ESCAPES = Object.freeze({
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\',
  '/': '/',
})

/**
 * Decodes a JSON string body starting just after its opening quote.
 *
 * Stops at the closing quote, at the end of the buffer, or at an escape that
 * has not finished arriving — the last two being the same answer to the
 * caller: this is what there is so far.
 */
function decodeFrom(buffer, start) {
  let value = ''
  let index = start

  while (index < buffer.length) {
    const char = buffer[index]

    if (char === '"') return { value, complete: true }

    if (char !== '\\') {
      value += char
      index += 1
      continue
    }

    const escape = buffer[index + 1]
    // The backslash arrived and what it escapes did not. Held back whole.
    if (escape === undefined) return { value, complete: false }

    if (escape === 'u') {
      const hex = buffer.slice(index + 2, index + 6)
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return { value, complete: false }
      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += 6
      continue
    }

    value += ESCAPES[escape] ?? escape
    index += 2
  }

  return { value, complete: false }
}

/**
 * The value of `field` in a partial JSON object, as far as it has arrived.
 *
 * Answers `{ found, value, complete }`. `found` is false until the key and the
 * opening quote of its value are both present, which keeps the caller from
 * mistaking "not yet" for "empty string".
 *
 * The scan tracks strings properly rather than searching for the key as text,
 * so a field whose *value* mentions the field name cannot be mistaken for the
 * field itself.
 */
export function partialString(buffer, field) {
  const text = typeof buffer === 'string' ? buffer : ''
  let index = 0

  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1
      continue
    }

    const token = decodeFrom(text, index + 1)
    if (!token.complete) return { found: false, value: '', complete: false }

    // Where the scan resumes: past this string's closing quote. Re-decoding to
    // find it is wasteful but correct, and these buffers are kilobytes.
    let end = index + 1
    let escaped = false
    while (end < text.length) {
      if (escaped) escaped = false
      else if (text[end] === '\\') escaped = true
      else if (text[end] === '"') break
      end += 1
    }

    let after = end + 1
    while (after < text.length && /\s/.test(text[after])) after += 1

    if (token.value !== field || text[after] !== ':') {
      index = end + 1
      continue
    }

    let value = after + 1
    while (value < text.length && /\s/.test(text[value])) value += 1

    // The key is here but its value has not started, or is not a string.
    if (text[value] !== '"') return { found: false, value: '', complete: false }

    return { found: true, ...decodeFrom(text, value + 1) }
  }

  return { found: false, value: '', complete: false }
}

/**
 * Splits an SSE byte stream into `{ event, data }` frames.
 *
 * Stateful because frames arrive split across chunks — a `data:` line can be
 * cut in half by a TCP boundary, and a parser that forgot the first half would
 * drop a token roughly whenever the network felt like it.
 */
export function createEventStreamParser() {
  let buffer = ''

  return {
    /** Feeds a chunk in, answers the frames that completed because of it. */
    push(chunk) {
      buffer += chunk
      const frames = []

      // Frames end at a blank line. \r\n is tolerated: the spec allows it and
      // proxies rewrite line endings.
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer)
        if (!boundary) break

        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        if (raw.trim()) frames.push(parseFrame(raw))
      }

      return frames
    },
  }
}

function parseFrame(raw) {
  let event = 'message'
  const data = []

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }

  return { event, data: data.join('\n') }
}
