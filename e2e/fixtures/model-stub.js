import http from 'node:http'

/**
 * A stand-in for the Anthropic Messages API, for the end-to-end suite.
 *
 * The point is not to pretend to be a model. It is to exercise everything on
 * *our* side of the request — the prompt built from the room, the tool-use
 * answer parsed back, the paths refused, the create-versus-modify decision,
 * the review screen and the apply — against a real browser and a real server,
 * deterministically and for free.
 *
 * So the answer is derived from the request rather than canned: it is shaped
 * from the tool schema it was handed, so the blocks that come back are exactly
 * the ones the action declared it produces. A test that sees a `findings` list
 * has proved the block registry built a schema, the model was asked with it,
 * and the sanitiser read it back — none of which a fixed reply could show.
 *
 * It deliberately also returns one path the server must refuse, so the
 * "nothing dangerous gets through" guarantee is exercised end to end rather
 * than only in unit tests.
 */

const PORT = Number(process.env.MODEL_STUB_PORT ?? 4100)

/**
 * The room's code buffer, recovered from the prompt.
 *
 * The server sends it with line numbers so the answer can cite them, so they
 * are stripped back off here. A patch has to be the buffer as it actually
 * reads or the server will refuse it as changing nothing — which makes this
 * the part that proves the whole round trip, numbering included.
 */
function bufferIn(prompt) {
  const section = prompt.split('THE ROOM’S CODE BUFFER\n')[1]
  if (!section) return null

  const lines = []
  // Split on either ending. `.` does not match a carriage return in JavaScript,
  // so a CRLF buffer — which is every buffer a Windows editor has touched —
  // would fail the line pattern on its very first line and recover nothing.
  for (const line of section.split(/\r?\n/)) {
    const match = /^\s*\d+ {2}(.*)$/.exec(line)
    if (!match) break
    lines.push(match[1])
  }

  return lines.length ? lines.join('\n') : null
}

/** Which room data the server said it had nothing to send for. */
function emptySourcesIn(prompt) {
  return [...prompt.matchAll(/^([A-Z’' ]+): nothing recorded/gm)].map((match) =>
    match[1].toLowerCase()
  )
}

/**
 * An answer shaped by the schema it was handed.
 *
 * Every block is filled only if the action asked for it, which is what makes
 * this a test of the registry rather than of a fixture: the blocks that come
 * back are exactly the ones the action declared it produces.
 */
function copilotAnswer(tool, prompt) {
  const properties = tool?.input_schema?.properties ?? {}
  const buffer = bufferIn(prompt)
  const answer = {}

  if (properties.answer) {
    answer.answer =
      'Answering with ' +
      Object.keys(properties).length +
      ' blocks. ' +
      emptySourcesIn(prompt).length +
      ' of the things I was offered were empty. The buffer is ' +
      (buffer ? buffer.split('\n').length + ' lines long' : 'not part of this request') +
      '.'
  }

  if (properties.findings) {
    answer.findings = [
      {
        title: 'Subtraction where the name says addition',
        detail: 'The function is called add and returns a - b.',
        severity: 'high',
        evidence: ['line 2'],
      },
      { title: 'No test covers the empty case', severity: 'low', evidence: [] },
    ]
  }

  if (properties.steps) {
    answer.steps = [{ step: 'Fix the operator', detail: 'Then run it again.' }]
  }

  if (properties.tasks) {
    answer.tasks = [{ title: 'Add a regression test', size: 'small' }]
  }

  if (properties.comparison) {
    answer.comparison = [{ subject: 'exit code', before: '1', after: '0', note: 'It passes now.' }]
  }

  if (properties.questions) answer.questions = ['Which version of Node is this running on?']
  if (properties.assumptions) answer.assumptions = ['ES modules, since the code uses import.']

  // Deliberately one real id and one invented one: the server must keep the
  // first, drop the second, and say that it dropped one.
  if (properties.citations) answer.citations = ['e1', 'not-a-real-event']

  if (properties.files) {
    answer.files = [
      {
        path: 'test/generated.test.js',
        action: 'create',
        language: 'javascript',
        contents: 'it("adds", () => {})\n',
        rationale: 'Covers the function the copilot was shown.',
      },
      // The one the server must refuse, here too.
      { path: '../escaped.js', action: 'create', contents: 'never\n' },
    ]
  }

  if (properties.patch && buffer) {
    answer.patch = {
      contents: buffer.includes('a - b')
        ? buffer.replace('a - b', 'a + b')
        : buffer + '\n// reviewed by the copilot\n',
      rationale: 'add() was subtracting.',
    }
  }

  return answer
}

/* ---------- delivery ---------- */

function answerFor(parsed, prompt) {
  return copilotAnswer(parsed?.tools?.[0], prompt)
}

/**
 * The streaming shape, which is what the copilot asks for.
 *
 * Chopped into small pieces on purpose — fragment boundaries landing inside
 * strings and escapes are exactly what the server's incremental reader exists
 * for, and one clean chunk would exercise none of it.
 */
function streamAnswer(res, parsed, prompt) {
  const tool = parsed?.tools?.[0]
  const json = JSON.stringify(answerFor(parsed, prompt))

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  const send = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')

  send('message_start', {
    message: { model: parsed.model ?? 'stub-model', usage: { input_tokens: prompt.length } },
  })
  send('content_block_start', {
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_stub', name: tool?.name },
  })

  for (let at = 0; at < json.length; at += 9) {
    send('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: json.slice(at, at + 9) },
    })
  }

  send('content_block_stop', { index: 0 })
  send('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 512 } })
  res.end()
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
    res.writeHead(404).end('not found')
    return
  }

  // The real API refuses an unauthenticated request; so does this, because
  // "we forgot to send the key" should fail here rather than pass quietly.
  if (!req.headers['x-api-key']) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'missing x-api-key' } }))
    return
  }

  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })

  req.on('end', () => {
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      res.writeHead(400).end('bad json')
      return
    }

    const prompt = parsed?.messages?.[0]?.content ?? ''

    if (parsed.stream) {
      streamAnswer(res, parsed, prompt)
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'msg_stub',
        model: parsed.model ?? 'stub-model',
        stop_reason: 'tool_use',
        usage: { input_tokens: prompt.length, output_tokens: 512 },
        content: [
          {
            type: 'tool_use',
            id: 'toolu_stub',
            name: parsed?.tools?.[0]?.name ?? 'answer',
            input: answerFor(parsed, prompt),
          },
        ],
      })
    )
  })
})

server.listen(PORT, '127.0.0.1', () => {
  // Playwright waits for this port before starting the suite.
  process.stdout.write('model stub listening on ' + PORT + '\n')
})
