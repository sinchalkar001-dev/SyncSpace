import http from 'node:http'

/**
 * A stand-in for the Anthropic Messages API, for the end-to-end suite.
 *
 * The point is not to pretend to be a model. It is to exercise everything on
 * *our* side of the request — the architecture read off the board, the prompt
 * built from it, the tool-use answer parsed back, the paths refused, the
 * create-versus-modify decision, the review screen and the apply — against a
 * real browser and a real server, deterministically and for free.
 *
 * So the answer is derived from the prompt rather than canned: the files it
 * proposes are named after the components it was actually sent. A test that
 * sees `client.js` come back has proved the graph travelled the whole way,
 * which a fixed reply could never show.
 *
 * It deliberately also returns one path the server must refuse, so the
 * "nothing dangerous gets through" guarantee is exercised end to end rather
 * than only in unit tests.
 */

const PORT = Number(process.env.MODEL_STUB_PORT ?? 4100)

/** Pulls the component keys out of the prompt the server built. */
function componentsIn(prompt) {
  const section = prompt.split('COMPONENTS')[1]?.split('CONNECTIONS')[0] ?? ''
  return [...section.matchAll(/^\s+- ([a-z0-9-]+) \[/gm)].map((match) => match[1])
}

function proposalFor(prompt) {
  const components = componentsIn(prompt)
  const connections = (prompt.match(/->/g) ?? []).length

  const files = components.map((key) => ({
    path: 'src/' + key + '.js',
    action: 'create',
    language: 'javascript',
    contents:
      '// Generated for the "' + key + '" component.\n' +
      'export function ' + key.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + '() {\n' +
      '  throw new Error("not implemented")\n' +
      '}\n',
    rationale: 'Stands for the ' + key + ' box on the whiteboard.',
  }))

  // One the server has to refuse. If it ever appears in the change set, the
  // path check has stopped working.
  files.push({
    path: '../escaped.js',
    action: 'create',
    contents: 'module.exports = "this must never be offered"\n',
  })

  return {
    summary:
      'A ' + components.length + '-component system with ' + connections + ' directed connections.',
    plan: [
      { step: 'Model the data', detail: 'Start from the store at the end of the diagram.' },
      { step: 'Wire the components', detail: 'One module per box, joined as the arrows show.' },
    ],
    assumptions: ['Node with ES modules, because the diagram does not say otherwise.'],
    questions: components.length > 0 ? ['Which database should the store use?'] : [],
    files,
  }
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
            name: 'propose_implementation',
            input: proposalFor(prompt),
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
