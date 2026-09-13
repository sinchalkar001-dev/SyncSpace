/**
 * Reading a server-sent event stream out of a fetch response.
 *
 * Not `EventSource`, which can only issue a GET. A copilot request carries what
 * it is about — a line range, a point in the history, a note somebody typed —
 * and putting that in a query string would make every answer cacheable by
 * anything between here and the server, as well as putting the note in logs.
 * So the request is a POST and the stream is read by hand, which is about
 * thirty lines and buys the ability to send a body and an Authorization header.
 *
 * The other reason: `EventSource` reconnects on its own. For a stream that
 * costs money to produce and is recorded when it finishes, an automatic retry
 * is not a feature — it is a second answer nobody asked for.
 */

const NEWLINE = /\r?\n/

/**
 * Splits the byte stream into `{ event, data }` frames.
 *
 * Stateful because frames arrive split across reads: a `data:` line cut in
 * half by a packet boundary is ordinary, and a parser that forgot the first
 * half would drop a token whenever the network felt like it.
 */
export function createFrameReader() {
  let buffer = ''

  return function read(chunk) {
    buffer += chunk
    const frames = []

    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer)
      if (!boundary) break

      const raw = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      if (!raw.trim()) continue

      let event = 'message'
      const data = []

      for (const line of raw.split(NEWLINE)) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }

      frames.push({ event, data: data.join('\n') })
    }

    return frames
  }
}

/**
 * Reads a response body as events, calling `onEvent(name, payload)` for each.
 *
 * A frame whose data is not JSON is skipped rather than thrown on: it is a
 * frame this code does not understand, which is not a reason to abandon an
 * answer that is otherwise arriving perfectly well. Anything genuinely wrong
 * comes through as an `error` event, which the caller handles.
 */
export async function readEventStream(response, onEvent) {
  const reader = response.body?.getReader?.()
  if (!reader) throw new Error('This browser cannot read a streamed response.')

  const decoder = new TextDecoder()
  const read = createFrameReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      for (const frame of read(decoder.decode(value, { stream: true }))) {
        if (frame.data === '[DONE]') continue

        let payload
        try {
          payload = JSON.parse(frame.data)
        } catch {
          continue
        }

        onEvent(frame.event, payload)
      }
    }
  } finally {
    reader.releaseLock?.()
  }
}
