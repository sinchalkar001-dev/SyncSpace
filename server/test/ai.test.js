import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  aiStatus,
  askForImplementation,
  isSafePath,
  sanitiseProposal,
  TARGET_KEYS,
} from '../src/services/ai.service.js'
import { providerNamed, toGeminiSchema } from '../src/services/ai.providers.js'
import { env } from '../src/config/env.js'

/**
 * What the server is willing to believe from a model.
 *
 * Everything here is about not trusting the answer. A generation is text
 * produced by something that has never seen this codebase, arriving as a list
 * of files with paths — which is to say, as instructions. It is displayed,
 * stored, compared against real filenames and eventually written, so the
 * checks below are the boundary between "the model suggested something odd"
 * and "the model was obeyed".
 */

const key = env.ANTHROPIC_API_KEY
const googleKey = env.GOOGLE_API_KEY
const provider = env.AI_PROVIDER
const enabled = env.AI_ENABLED

afterEach(() => {
  env.ANTHROPIC_API_KEY = key
  env.GOOGLE_API_KEY = googleKey
  env.AI_PROVIDER = provider
  env.AI_ENABLED = enabled
  vi.restoreAllMocks()
})

describe('isSafePath', () => {
  it('accepts an ordinary relative path', () => {
    expect(isSafePath('src/services/auth.js')).toBe(true)
    expect(isSafePath('README.md')).toBe(true)
    expect(isSafePath('src/models/User.ts')).toBe(true)
  })

  /** The reason this function exists. */
  it('refuses anything that climbs out of the project', () => {
    expect(isSafePath('../secrets.env')).toBe(false)
    expect(isSafePath('src/../../etc/passwd')).toBe(false)
    expect(isSafePath('a/b/../../../c')).toBe(false)
    expect(isSafePath('./config.js')).toBe(false)
  })

  it('refuses an absolute path in any dialect', () => {
    expect(isSafePath('/etc/passwd')).toBe(false)
    expect(isSafePath('C:/Windows/System32/x.dll')).toBe(false)
    expect(isSafePath('\\\\server\\share\\x')).toBe(false)
    expect(isSafePath('\\etc\\passwd')).toBe(false)
  })

  /**
   * Backslashes are refused outright rather than converted. On Windows they
   * are separators, everywhere else they are ordinary characters, and a path
   * that means two things is not one this server should be repeating back as
   * a filename.
   */
  it('refuses backslashes rather than guessing what they meant', () => {
    expect(isSafePath('src\\services\\auth.js')).toBe(false)
  })

  it('refuses a null byte, a directory, and nothing at all', () => {
    expect(isSafePath('src/a\0b.js')).toBe(false)
    expect(isSafePath('src/services/')).toBe(false)
    expect(isSafePath('')).toBe(false)
    expect(isSafePath('   ')).toBe(false)
    expect(isSafePath(null)).toBe(false)
    expect(isSafePath(42)).toBe(false)
  })

  it('refuses a path long enough to be a denial of service on its own', () => {
    expect(isSafePath('a/'.repeat(200) + 'b.js')).toBe(false)
  })
})

describe('sanitiseProposal', () => {
  const file = (extra = {}) => ({
    path: 'src/index.js',
    action: 'create',
    contents: 'export const x = 1\n',
    ...extra,
  })

  it('keeps a well-formed file', () => {
    const result = sanitiseProposal({ files: [file()] })

    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toMatchObject({ path: 'src/index.js', action: 'create' })
    expect(result.files[0].size).toBeGreaterThan(0)
    expect(result.rejected).toEqual([])
  })

  /**
   * One bad entry costs that entry and a line saying so — not the whole
   * generation, which the person has already waited a minute for.
   */
  it('drops a dangerous path and keeps the rest', () => {
    const result = sanitiseProposal({
      files: [file({ path: '../../etc/passwd' }), file({ path: 'src/ok.js' })],
    })

    expect(result.files.map((f) => f.path)).toEqual(['src/ok.js'])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]).toMatch(/unusable path/i)
  })

  it('drops an unknown action', () => {
    const result = sanitiseProposal({ files: [file({ action: 'rename' })] })

    expect(result.files).toEqual([])
    expect(result.rejected[0]).toMatch(/unknown action/i)
  })

  it('drops a second entry for the same path', () => {
    const result = sanitiseProposal({
      files: [file({ contents: 'first' }), file({ contents: 'second' })],
    })

    expect(result.files).toHaveLength(1)
    expect(result.files[0].contents).toBe('first')
    expect(result.rejected[0]).toMatch(/second entry/i)
  })

  it('drops a create with nothing in it', () => {
    const result = sanitiseProposal({ files: [file({ contents: '   ' })] })

    expect(result.files).toEqual([])
    expect(result.rejected[0]).toMatch(/no contents/i)
  })

  /** A delete proposes removal; contents would be meaningless. */
  it('keeps a delete without contents', () => {
    const result = sanitiseProposal({
      files: [{ path: 'src/old.js', action: 'delete' }],
    })

    expect(result.files).toHaveLength(1)
    expect(result.files[0].action).toBe('delete')
    expect(result.files[0].contents).toBe('')
  })

  it('refuses a single file larger than the cap', () => {
    const result = sanitiseProposal({ files: [file({ contents: 'x'.repeat(200_000) })] })

    expect(result.files).toEqual([])
    expect(result.rejected[0]).toMatch(/larger than one file may be/i)
  })

  it('stops once the whole change set is too big', () => {
    const files = Array.from({ length: 12 }, (_, index) =>
      file({ path: 'src/f' + index + '.js', contents: 'x'.repeat(100_000) })
    )
    const result = sanitiseProposal({ files })

    expect(result.files.length).toBeLessThan(files.length)
    expect(result.rejected.some((line) => /size limit/i.test(line))).toBe(true)
  })

  it('stops at the file count cap', () => {
    const files = Array.from({ length: 60 }, (_, index) =>
      file({ path: 'src/f' + index + '.js' })
    )
    const result = sanitiseProposal({ files })

    expect(result.files).toHaveLength(40)
    expect(result.rejected.some((line) => /More than 40 files/i.test(line))).toBe(true)
  })

  it('keeps the plan, assumptions and questions as text', () => {
    const result = sanitiseProposal({
      summary: 'A thing.',
      plan: [{ step: 'Do it', detail: 'carefully' }, { step: '' }],
      assumptions: ['Postgres', '', '   '],
      questions: ['Which auth?'],
      files: [],
    })

    expect(result.summary).toBe('A thing.')
    expect(result.plan).toEqual([{ step: 'Do it', detail: 'carefully' }])
    expect(result.assumptions).toEqual(['Postgres'])
    expect(result.questions).toEqual(['Which auth?'])
  })

  it('survives an answer with nothing in it at all', () => {
    expect(() => sanitiseProposal(null)).not.toThrow()
    expect(() => sanitiseProposal({})).not.toThrow()
    expect(sanitiseProposal({}).files).toEqual([])
  })
})

describe('aiStatus', () => {
  it('is unavailable with a reason when no key is configured', () => {
    env.ANTHROPIC_API_KEY = undefined
    const status = aiStatus()

    expect(status.enabled).toBe(false)
    expect(status.reason).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('is unavailable with a different reason when switched off', () => {
    env.ANTHROPIC_API_KEY = 'sk-ant-test'
    env.AI_ENABLED = false
    const status = aiStatus()

    expect(status.enabled).toBe(false)
    expect(status.reason).toMatch(/switched off/i)
  })

  it('is available, and never says what the key is', () => {
    env.ANTHROPIC_API_KEY = 'sk-ant-secret-value'
    env.AI_ENABLED = true
    const status = aiStatus()

    expect(status.enabled).toBe(true)
    expect(status.provider).toBe('anthropic')
    // No AI_MODEL set, so the provider's own default stands in.
    expect(status.model).toBe('claude-sonnet-5')
    expect(JSON.stringify(status)).not.toContain('secret-value')
  })

  /**
   * Which service to call is read off the key, because that is a fact about
   * the credential rather than a second setting to keep in step with it — and
   * a key paired with the wrong provider fails as a 401 from a service it was
   * never issued for, which is a miserable thing to debug.
   */
  it('picks the provider from the shape of the key', () => {
    env.AI_ENABLED = true

    env.ANTHROPIC_API_KEY = 'sk-ant-abc123'
    expect(aiStatus()).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' })

    env.ANTHROPIC_API_KEY = undefined
    env.GOOGLE_API_KEY = 'AIzaSyExample'
    expect(aiStatus()).toMatchObject({ provider: 'google', model: 'gemini-3.6-flash' })
  })

  it('refuses to guess at a key it does not recognise', () => {
    env.AI_ENABLED = true
    env.ANTHROPIC_API_KEY = 'some-gateway-token'

    const status = aiStatus()

    expect(status.enabled).toBe(false)
    expect(status.reason).toMatch(/AI_PROVIDER/)
  })

  it('lets AI_PROVIDER settle it for a key of neither shape', () => {
    env.AI_ENABLED = true
    env.ANTHROPIC_API_KEY = 'some-gateway-token'
    env.AI_PROVIDER = 'anthropic'

    expect(aiStatus()).toMatchObject({ enabled: true, provider: 'anthropic' })
  })
})

describe('provider wiring', () => {
  it('sends an Anthropic request the way Anthropic expects it', () => {
    const call = providerNamed('anthropic').request({
      baseUrl: 'https://api.anthropic.com',
      key: 'sk-ant-x',
      model: 'claude-sonnet-5',
      system: 'sys',
      prompt: 'p',
      tool: { name: 't', description: 'd', input_schema: { type: 'object' } },
      maxTokens: 100,
    })

    expect(call.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call.headers['x-api-key']).toBe('sk-ant-x')
    expect(call.headers['anthropic-version']).toBe('2023-06-01')
    expect(call.body.tool_choice).toEqual({ type: 'tool', name: 't' })
  })

  it('sends a Google request the way Google expects it', () => {
    const call = providerNamed('google').request({
      baseUrl: 'https://generativelanguage.googleapis.com',
      key: 'AIza-x',
      model: 'gemini-3.6-flash',
      system: 'sys',
      prompt: 'p',
      tool: { name: 't', description: 'd', input_schema: { type: 'object' } },
      maxTokens: 100,
    })

    expect(call.url).toContain('/v1beta/models/gemini-3.6-flash:generateContent')
    // A header, not ?key= — a query string is what ends up in proxy logs.
    expect(call.headers['x-goog-api-key']).toBe('AIza-x')
    expect(call.url).not.toContain('AIza-x')
    expect(call.body.toolConfig.functionCallingConfig).toEqual({
      mode: 'ANY',
      allowedFunctionNames: ['t'],
    })
  })

  /** Gemini takes a subset of OpenAPI, not JSON Schema: types are upper case. */
  it('converts the schema into the dialect Gemini accepts', () => {
    const converted = toGeminiSchema({
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { action: { type: 'string', enum: ['create'] } },
            required: ['action'],
          },
        },
      },
      required: ['files'],
    })

    expect(converted.type).toBe('OBJECT')
    expect(converted.properties.files.type).toBe('ARRAY')
    expect(converted.properties.files.items.type).toBe('OBJECT')
    expect(converted.properties.files.items.properties.action.type).toBe('STRING')
    expect(converted.properties.files.items.properties.action.enum).toEqual(['create'])
    expect(converted.required).toEqual(['files'])
  })

  it('reads an answer back from either vendor into the same shape', () => {
    const fromAnthropic = providerNamed('anthropic').parse(
      {
        model: 'claude-sonnet-5',
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 9 },
        content: [{ type: 'tool_use', name: 't', input: { summary: 'a' } }],
      },
      't'
    )

    const fromGoogle = providerNamed('google').parse(
      {
        modelVersion: 'gemini-3.6-flash',
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 },
        candidates: [
          { finishReason: 'STOP', content: { parts: [{ functionCall: { name: 't', args: { summary: 'a' } } }] } },
        ],
      },
      't'
    )

    expect(fromAnthropic.input).toEqual({ summary: 'a' })
    expect(fromGoogle.input).toEqual({ summary: 'a' })
    expect(fromAnthropic.usage).toEqual({ inputTokens: 5, outputTokens: 9 })
    expect(fromGoogle.usage).toEqual({ inputTokens: 5, outputTokens: 9 })
  })

  /** A cut-off answer must be explained the same way whoever produced it. */
  it('normalises a truncated answer across vendors', () => {
    expect(
      providerNamed('anthropic').parse({ stop_reason: 'max_tokens', content: [] }, 't').stopReason
    ).toBe('max_tokens')

    expect(
      providerNamed('google').parse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }, 't').stopReason
    ).toBe('max_tokens')
  })
})

describe('askForImplementation', () => {
  const architecture = { nodes: [], edges: [], notes: [], warnings: [] }

  const answer = (body, ok = true, status = 200) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    })

  const toolUse = (input) => ({
    model: 'claude-sonnet-5',
    content: [{ type: 'tool_use', name: 'propose_implementation', input }],
    usage: { input_tokens: 10, output_tokens: 20 },
  })

  beforeEach(() => {
    env.ANTHROPIC_API_KEY = 'sk-ant-test'
    env.AI_ENABLED = true
  })

  it('refuses before making a request when no key is configured', async () => {
    env.ANTHROPIC_API_KEY = undefined
    const fetchSpy = answer({})

    await expect(
      askForImplementation({ architecture, targets: ['backend'] })
    ).rejects.toMatchObject({ code: 'ai_disabled', status: 503 })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends the graph, the targets and the key, and returns the proposal', async () => {
    const fetchSpy = answer(
      toolUse({ summary: 'ok', plan: [], files: [], assumptions: [], questions: [] })
    )

    const result = await askForImplementation({
      architecture: { nodes: [{ key: 'api', type: 'api', label: 'API' }], edges: [], notes: [], warnings: [] },
      targets: ['backend', 'api'],
    })

    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/v1/messages')
    expect(init.headers['x-api-key']).toBe('sk-ant-test')
    expect(init.headers['anthropic-version']).toBe('2023-06-01')

    const body = JSON.parse(init.body)
    expect(body.messages[0].content).toContain('api [api] "API"')
    expect(body.messages[0].content).toContain('backend:')
    // Forced, so the answer cannot come back as prose that has to be parsed.
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'propose_implementation' })

    expect(result.proposal.summary).toBe('ok')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })

  it('sanitises what comes back rather than trusting it', async () => {
    answer(
      toolUse({
        summary: 's',
        plan: [],
        assumptions: [],
        questions: [],
        files: [
          { path: '../escape.js', action: 'create', contents: 'x' },
          { path: 'src/fine.js', action: 'create', contents: 'x' },
        ],
      })
    )

    const result = await askForImplementation({ architecture, targets: ['backend'] })

    expect(result.proposal.files.map((f) => f.path)).toEqual(['src/fine.js'])
    expect(result.proposal.rejected).toHaveLength(1)
  })

  it('reports a rate limit as its own thing', async () => {
    answer({ error: 'slow down' }, false, 429)

    await expect(
      askForImplementation({ architecture, targets: ['backend'] })
    ).rejects.toMatchObject({ code: 'ai_rate_limited' })
  })

  /** An answer cut off mid-file is the most likely real failure. */
  it('says the answer was cut off rather than "malformed"', async () => {
    answer({ content: [{ type: 'text', text: 'half a file' }], stop_reason: 'max_tokens' })

    await expect(
      askForImplementation({ architecture, targets: ['backend'] })
    ).rejects.toMatchObject({ code: 'ai_malformed', message: expect.stringMatching(/cut off/i) })
  })

  it('reports a network failure without echoing the request', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED sk-test@host'), { code: 'ECONNREFUSED' })
    )

    const error = await askForImplementation({ architecture, targets: ['backend'] }).catch((e) => e)

    expect(error.code).toBe('ai_unreachable')
    expect(error.message).not.toContain('sk-ant-test')
  })

  it('never puts the provider body in the message it shows a caller', async () => {
    answer({ error: { message: 'your key sk-ant-leak is invalid' } }, false, 401)

    const error = await askForImplementation({ architecture, targets: ['backend'] }).catch((e) => e)

    expect(error.message).not.toContain('sk-ant-leak')
    expect(error.message).toContain('401')
  })
})

describe('targets', () => {
  it('offers the four the brief asks for', () => {
    expect(TARGET_KEYS).toEqual(['backend', 'api', 'database', 'frontend'])
  })
})
