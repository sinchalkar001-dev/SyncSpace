import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { env } from '../src/config/env.js'
import { File } from '../src/models/File.js'
import { Snapshot } from '../src/models/Snapshot.js'
import { Execution } from '../src/models/Execution.js'
import { CopilotRun } from '../src/models/CopilotRun.js'
import { ensureRoom, getRoom } from '../src/services/room.service.js'
import { ACTIONS, actionById, CONTEXT_IDS } from '../src/services/copilot/actions.js'
import { toolFor } from '../src/services/copilot/blocks.js'
import { matchLineEndings, resetCopilotSlots } from '../src/services/copilot/run.js'

/**
 * The copilot, over HTTP, with the model stubbed at `fetch`.
 *
 * Stubbed at the network boundary rather than by mocking the service, so
 * everything the server does with an answer is actually exercised: the
 * streaming, the sanitising, the decision about what a proposed file does to
 * this room, and the two apply paths.
 *
 * The tests that matter most are the ones about *not* doing things. A copilot
 * is a confident stranger with write access, and almost every way this feature
 * could go wrong is a way of it being believed: an answer read from a client's
 * own request rather than the room, a file written over one nobody was shown,
 * a patch landing on top of somebody's editing, a citation to an event that
 * never happened.
 */

let app

const OWNER = { email: 'ada@syncspace.test', password: 'correct-horse-battery', name: 'Ada' }
const GUEST = { email: 'bob@syncspace.test', password: 'a-different-passphrase', name: 'Bob' }

const key = env.ANTHROPIC_API_KEY
const enabled = env.AI_ENABLED

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  resetCopilotSlots()
  app = createApp()
  env.ANTHROPIC_API_KEY = 'sk-ant-test'
  env.AI_ENABLED = true
})

afterEach(() => {
  env.ANTHROPIC_API_KEY = key
  env.AI_ENABLED = enabled
  vi.restoreAllMocks()
})

const register = async (who = OWNER) => {
  const res = await request(app).post('/api/v1/auth/register').send(who)
  expect(res.status).toBe(201)
  return res.body
}

const BUFFER = ['function add(a, b) {', '  return a - b', '}', '', 'console.log(add(2, 2))'].join('\n')

/** Seeds a room with a code buffer and shapes, the way a snapshot would. */
async function seedRoom(roomId, { code = BUFFER, shapes = [] } = {}) {
  await ensureRoom(roomId)

  const doc = new Y.Doc()
  doc.getText('code').insert(0, code)
  doc.getArray('shapes').push(
    shapes.map((shape) => {
      const map = new Y.Map()
      Object.entries(shape).forEach(([field, value]) => map.set(field, value))
      return map
    })
  )

  await Snapshot.create({
    roomId,
    state: Buffer.from(Y.encodeStateAsUpdate(doc)),
    seq: 0,
    size: 1,
  })
  doc.destroy()
}

/* ---------- stubbing a streaming model ---------- */

/** A fetch answer shaped like a body this server can read a stream out of. */
function streamingResponse(frames) {
  const encoder = new TextEncoder()
  const chunks = frames.map((frame) =>
    encoder.encode('event: ' + frame.event + '\ndata: ' + JSON.stringify(frame.data) + '\n\n')
  )

  let index = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length ? { done: false, value: chunks[index++] } : { done: true },
        releaseLock: () => {},
        cancel: async () => {},
      }),
    },
  }
}

/**
 * The model answering `input`, delivered a few characters at a time.
 *
 * Deliberately chopped at seven characters rather than sent whole: fragment
 * boundaries landing inside strings and escapes are the case the incremental
 * reader exists for, and a stub that sent one clean chunk would test none of
 * it.
 */
function modelStreams(input, { chunk = 7 } = {}) {
  const json = JSON.stringify(input)
  const frames = [
    { event: 'message_start', data: { message: { model: 'claude-test', usage: { input_tokens: 120 } } } },
  ]

  for (let at = 0; at < json.length; at += chunk) {
    frames.push({
      event: 'content_block_delta',
      data: { delta: { type: 'input_json_delta', partial_json: json.slice(at, at + chunk) } },
    })
  }

  frames.push({
    event: 'message_delta',
    data: { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 400 } },
  })

  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamingResponse(frames))
}

/** Parses an event stream out of a buffered supertest response. */
function framesOf(text) {
  return text
    .split(/\n\n/)
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message'
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? '{}'
      return { event, data: JSON.parse(data) }
    })
}

const run = (roomId, body, token) =>
  request(app)
    .post('/api/v1/rooms/' + roomId + '/copilot/runs')
    .set('Authorization', 'Bearer ' + token)
    .send(body)

/** Runs an action and answers the parsed frames, asserting the stream opened. */
async function ask(roomId, body, token) {
  const res = await run(roomId, body, token)
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toMatch(/text\/event-stream/)
  return framesOf(res.text)
}

const frameOf = (frames, event) => frames.find((frame) => frame.event === event)

/* ---------- the registry ---------- */

describe('the action registry', () => {
  /**
   * The point of the framework: adding a capability is adding an entry, and
   * the entry is checkable. These are the checks actions.js makes at import
   * time, asserted here so a failure reads as a test rather than as the whole
   * server failing to start.
   */
  it('covers all five contexts, with every action in one of them', () => {
    expect(CONTEXT_IDS).toEqual(['whiteboard', 'code', 'execution', 'replay', 'room'])
    for (const action of ACTIONS) expect(CONTEXT_IDS).toContain(action.context)
  })

  it('builds a usable tool schema for every action', () => {
    for (const action of ACTIONS) {
      const tool = toolFor(action)
      expect(tool.name).toMatch(/^[a-zA-Z0-9_]+$/)
      expect(tool.input_schema.required).toContain('answer')
      // Every block the action produces is in the schema, and nothing else.
      expect(Object.keys(tool.input_schema.properties).sort()).toEqual([...action.produces].sort())
    }
  })

  it('never offers to write without producing something to review', () => {
    for (const action of ACTIONS) {
      if (action.apply?.kind === 'files') expect(action.produces).toContain('files')
      if (action.apply?.kind === 'code') {
        expect(action.produces).toContain('patch')
        // A replacement for the whole buffer is only reviewable against the
        // whole buffer, so the action has to have read it.
        expect(action.sources).toContain('code')
      }
    }
  })

  it('keeps most actions unable to change anything at all', () => {
    const advice = ACTIONS.filter((action) => !action.apply)
    expect(advice.length).toBeGreaterThan(ACTIONS.length / 2)
  })
})

/* ---------- the catalogue ---------- */

describe('GET /copilot', () => {
  it('lists the contexts and actions, and says this person may ask', async () => {
    const owner = await register()
    await seedRoom('cat-1')

    const res = await request(app)
      .get('/api/v1/rooms/cat-1/copilot')
      .set('Authorization', 'Bearer ' + owner.token)

    expect(res.status).toBe(200)
    expect(res.body.allowed).toBe(true)
    expect(res.body.contexts.map((context) => context.id)).toEqual(CONTEXT_IDS)
    expect(res.body.actions.length).toBe(ACTIONS.length)

    const review = res.body.actions.find((action) => action.id === 'code.review')
    expect(review).toMatchObject({ context: 'code', title: 'Review', apply: null })
    expect(review.sources).toEqual(['code', 'selection'])
  })

  /** A prompt is ours. Publishing it would let anybody reproduce the answer. */
  it('never publishes the prompts', async () => {
    const owner = await register()
    await seedRoom('cat-2')

    const res = await request(app)
      .get('/api/v1/rooms/cat-2/copilot')
      .set('Authorization', 'Bearer ' + owner.token)

    for (const action of res.body.actions) expect(action.ask).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('staff engineer')
  })

  it('tells a guest why the copilot is not theirs to use, rather than hiding it', async () => {
    await ensureRoom('cat-3')
    const room = await getRoom('cat-3')
    room.isPublic = true
    await room.save()

    const res = await request(app).get('/api/v1/rooms/cat-3/copilot')

    expect(res.status).toBe(200)
    expect(res.body.allowed).toBe(false)
    expect(res.body.reason).toMatch(/Sign in/)
    // Still lists what it would do, so the interface can explain the feature.
    expect(res.body.actions.length).toBe(ACTIONS.length)
  })

  it('reports a deployment with no key as switched off, not broken', async () => {
    env.ANTHROPIC_API_KEY = undefined
    env.GOOGLE_API_KEY = undefined

    const owner = await register()
    await seedRoom('cat-4')

    const res = await request(app)
      .get('/api/v1/rooms/cat-4/copilot')
      .set('Authorization', 'Bearer ' + owner.token)

    expect(res.body.enabled).toBe(false)
    expect(res.body.reason).toMatch(/No model key/)
  })
})

/* ---------- running an action ---------- */

describe('POST /copilot/runs', () => {
  it('streams the sources, then the answer, then the result', async () => {
    const owner = await register()
    await seedRoom('run-1')

    modelStreams({
      answer: 'The subtraction on line 2 is what the name says is addition.',
      findings: [
        { title: 'add() subtracts', detail: 'Line 2 returns a - b.', severity: 'high', evidence: ['line 2'] },
      ],
      questions: [],
    })

    const frames = await ask('run-1', { action: 'code.review' }, owner.token)

    expect(frames.map((frame) => frame.event)).toEqual([
      'sources',
      ...frames.filter((frame) => frame.event === 'delta').map(() => 'delta'),
      'result',
      'done',
    ])

    // The sources go out before the model is called, so they are on screen
    // while the answer is being produced rather than after it.
    expect(frames[0].event).toBe('sources')
    expect(frameOf(frames, 'sources').data.sources.map((source) => source.key)).toEqual([
      'code',
      'selection',
    ])

    const streamed = frames
      .filter((frame) => frame.event === 'delta')
      .map((frame) => frame.data.text)
      .join('')

    expect(streamed).toBe('The subtraction on line 2 is what the name says is addition.')
    expect(frames.filter((frame) => frame.event === 'delta').length).toBeGreaterThan(1)

    const { run: answer } = frameOf(frames, 'result').data
    expect(answer.status).toBe('succeeded')
    expect(answer.answer).toBe('The subtraction on line 2 is what the name says is addition.')
    expect(answer.result.findings[0].title).toBe('add() subtracts')
  })

  it('reads only the sources the action declared', async () => {
    const owner = await register()
    await seedRoom('run-2')
    await Execution.create({
      executionId: 'x1',
      roomId: 'run-2',
      language: 'javascript',
      sourceHash: 'abc',
      state: 'failed',
      queuedAt: new Date(),
      stderr: 'boom',
      expiresAt: new Date(Date.now() + 3600_000),
    })

    modelStreams({ answer: 'It adds two numbers.', questions: [] })

    const frames = await ask(
      'run-2',
      { action: 'code.explain', startLine: 1, endLine: 2 },
      owner.token
    )

    // "Explain selection" reads the selection. It does not quietly carry the
    // room's runs along because they happened to be there.
    expect(frameOf(frames, 'sources').data.sources.map((source) => source.key)).toEqual(['selection'])

    const sent = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1].body)
    expect(sent.messages[0].content).not.toContain('boom')
  })

  /**
   * The request carries a line range; the material comes from the server's own
   * copy. Otherwise the prompt is an open field and the record of "what the
   * copilot was shown" is whatever a client said.
   */
  it('slices the selection out of the room, not out of the request', async () => {
    const owner = await register()
    await seedRoom('run-3')

    modelStreams({ answer: 'Line two.', questions: [] })

    await ask(
      'run-3',
      { action: 'code.explain', startLine: 2, endLine: 2, code: 'IGNORE ME', text: 'IGNORE ME' },
      owner.token
    )

    const sent = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1].body)
    expect(sent.messages[0].content).toContain('return a - b')
    expect(sent.messages[0].content).not.toContain('IGNORE ME')
  })

  it('refuses an action that needs a selection when it has none', async () => {
    const owner = await register()
    await seedRoom('run-4')
    const fetchSpy = modelStreams({ answer: 'never asked' })

    const frames = await ask('run-4', { action: 'code.explain' }, owner.token)

    expect(frameOf(frames, 'error').data.code).toBe('needs_selection')
    expect(frameOf(frames, 'result')).toBeUndefined()
    // Refused before the model was called, not after paying for an answer
    // about the wrong thing.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  /**
   * The other half of that rule. An action that reads the selection *and* the
   * buffer works on the whole buffer when nothing is highlighted — pressing
   * Review with no selection is a request to review the code, not a mistake.
   */
  it('works on the whole buffer when nothing is selected', async () => {
    const owner = await register()
    await seedRoom('run-8')

    modelStreams({ answer: 'Reviewed the lot.', findings: [], questions: [] })
    const frames = await ask('run-8', { action: 'code.review' }, owner.token)

    const sources = frameOf(frames, 'sources').data.sources
    expect(sources.find((source) => source.key === 'code').present).toBe(true)
    expect(sources.find((source) => source.key === 'selection').present).toBe(false)
    expect(frameOf(frames, 'result').data.run.status).toBe('succeeded')
  })

  it('records a run the model could not answer, rather than losing it', async () => {
    const owner = await register()
    await seedRoom('run-5')

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('slow down'),
    })

    const frames = await ask('run-5', { action: 'code.review' }, owner.token)

    expect(frameOf(frames, 'error').data.code).toBe('ai_unavailable')
    // Nothing of the provider's own answer reaches the client.
    expect(JSON.stringify(frames)).not.toContain('slow down')

    const [recorded] = await CopilotRun.find({ roomId: 'run-5' })
    expect(recorded.status).toBe('failed')
    expect(recorded.error).toMatch(/rate limiting/)
  })

  it('pins a run to where the history stood when it was asked', async () => {
    const owner = await register()
    await seedRoom('run-6')

    modelStreams({ answer: 'Nothing has happened yet.', findings: [], citations: [] })
    await ask('run-6', { action: 'room.summary' }, owner.token)

    const [recorded] = await CopilotRun.find({ roomId: 'run-6' })
    expect(recorded.throughSeq).toBe(0)
    expect(recorded.sources.map((source) => source.key)).toEqual(['timeline', 'runs', 'comments'])
  })

  /** A source with nothing in it is reported as consulted, not omitted. */
  it('says when a source it read was empty', async () => {
    const owner = await register()
    await seedRoom('run-7')

    modelStreams({ answer: 'No runs to compare.', comparison: [], findings: [] })
    const frames = await ask('run-7', { action: 'execution.compare' }, owner.token)

    const [runs] = frameOf(frames, 'sources').data.sources
    expect(runs).toMatchObject({ key: 'runs', present: false, detail: 'nothing recorded yet' })
  })
})

/* ---------- permission ---------- */

describe('who may ask', () => {
  it('refuses a viewer, without reading the room first', async () => {
    const owner = await register()
    const guest = await register(GUEST)
    await seedRoom('perm-1')

    const room = await getRoom('perm-1')
    room.owner = owner.user.id
    room.members.push({ user: guest.user.id, role: 'viewer' })
    await room.save()

    const fetchSpy = modelStreams({ answer: 'never' })

    const res = await run('perm-1', { action: 'code.review' }, guest.token)

    // A refusal is an ordinary refusal: nothing has been written, so it does
    // not have to be smuggled inside a 200.
    expect(res.status).toBe(403)
    // In the room but without the capability, so they are told which thing
    // they cannot do rather than that they cannot see a room they are in.
    expect(res.body.error.code).toBe('permission_denied')
    expect(res.body.error.message).toMatch(/copilot/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a guest in a public room', async () => {
    await ensureRoom('perm-2')
    const room = await getRoom('perm-2')
    room.isPublic = true
    await room.save()

    const res = await request(app)
      .post('/api/v1/rooms/perm-2/copilot/runs')
      .send({ action: 'code.review' })

    expect(res.status).toBe(401)
  })

  it('lets an editor ask', async () => {
    const owner = await register()
    const mate = await register(GUEST)
    await seedRoom('perm-3')

    const room = await getRoom('perm-3')
    room.owner = owner.user.id
    room.members.push({ user: mate.user.id, role: 'editor' })
    await room.save()

    modelStreams({ answer: 'Looks fine.', findings: [], questions: [] })
    const frames = await ask('perm-3', { action: 'code.review' }, mate.token)

    expect(frameOf(frames, 'result').data.run.status).toBe('succeeded')
  })
})

/* ---------- holding the answer to the room ---------- */

describe('what survives the answer', () => {
  it('drops a file whose path climbs out of the project, and says so', async () => {
    const owner = await register()
    await seedRoom('safe-1')

    modelStreams({
      answer: 'Two files.',
      files: [
        { path: '../../etc/passwd', action: 'create', contents: 'root:x:0:0' },
        { path: 'src/add.js', action: 'create', contents: 'export const add = (a, b) => a + b' },
      ],
      assumptions: [],
    })

    const frames = await ask('safe-1', { action: 'code.tests' }, owner.token)
    const { run: answer } = frameOf(frames, 'result').data

    expect(answer.files.map((file) => file.path)).toEqual(['src/add.js'])
    expect(answer.rejected.join(' ')).toMatch(/unusable path/)
  })

  /**
   * The model has not seen the room's files, so its own `action` is a guess.
   * A file landing on a name the room already has is a modification whatever
   * it called itself — which is what keeps "generate" from meaning "overwrite".
   */
  it('turns a create landing on an existing file into a reviewable change', async () => {
    const owner = await register()
    await seedRoom('safe-2')

    await request(app)
      .post('/api/v1/rooms/safe-2/files')
      .set('Authorization', 'Bearer ' + owner.token)
      // Content type set explicitly, as the apply path sets it: supertest
      // would otherwise infer application/javascript from the extension,
      // which this server does not accept.
      .attach('file', Buffer.from('the original', 'utf8'), {
        filename: 'src_add.js',
        contentType: 'text/plain',
      })
      .expect(201)

    modelStreams({
      answer: 'One file.',
      files: [{ path: 'src/add.js', action: 'create', contents: 'the replacement' }],
      assumptions: [],
    })

    const frames = await ask('safe-2', { action: 'code.tests' }, owner.token)
    const [file] = frameOf(frames, 'result').data.run.files

    expect(file.action).toBe('modify')
    expect(frameOf(frames, 'result').data.run.rejected.join(' ')).toMatch(/already exists/)
  })

  it('drops a citation to an event that never happened, and counts it', async () => {
    const owner = await register()
    await seedRoom('safe-3')

    modelStreams({
      answer: 'Somebody joined.',
      findings: [],
      citations: ['e1', 'e999', 'made-up'],
    })

    const frames = await ask('safe-3', { action: 'room.summary' }, owner.token)
    const { run: answer } = frameOf(frames, 'result').data

    for (const id of answer.result.citations) expect(answer.result.cited[id]).toBeDefined()
    expect(answer.result.citations).not.toContain('made-up')
    expect(answer.discarded).toBeGreaterThan(0)
  })

  it('ignores a block the action never asked for', async () => {
    const owner = await register()
    await seedRoom('safe-4')

    modelStreams({
      answer: 'A review.',
      findings: [],
      questions: [],
      // `code.review` cannot apply anything. A patch here would be a change
      // nobody would ever be shown a review screen for.
      patch: { contents: 'wiped', rationale: 'trust me' },
      files: [{ path: 'x.js', action: 'create', contents: 'also wiped' }],
    })

    const frames = await ask('safe-4', { action: 'code.review' }, owner.token)
    const { run: answer } = frameOf(frames, 'result').data

    expect(answer.patch).toBeNull()
    expect(answer.files).toEqual([])
  })

  it('normalises a severity it was not offered', async () => {
    const owner = await register()
    await seedRoom('safe-5')

    modelStreams({
      answer: 'One finding.',
      findings: [{ title: 'Something', severity: 'CATASTROPHIC' }],
      questions: [],
    })

    const frames = await ask('safe-5', { action: 'code.review' }, owner.token)
    expect(frameOf(frames, 'result').data.run.result.findings[0].severity).toBe('medium')
  })
})

/* ---------- applying a change set ---------- */

describe('applying files', () => {
  const CHANGE_SET = {
    answer: 'Two files.',
    files: [
      { path: 'test/add.test.js', action: 'create', contents: 'it("adds", () => {})' },
      { path: 'test/sub.test.js', action: 'create', contents: 'it("subtracts", () => {})' },
    ],
    assumptions: [],
  }

  async function proposeFiles(roomId, token) {
    await seedRoom(roomId)
    modelStreams(CHANGE_SET)
    const frames = await ask(roomId, { action: 'code.tests' }, token)
    return frameOf(frames, 'result').data.run
  }

  it('writes only what was accepted, and records the rest as turned down', async () => {
    const owner = await register()
    const answer = await proposeFiles('apply-1', owner.token)

    const res = await request(app)
      .post('/api/v1/rooms/apply-1/copilot/runs/' + answer.id + '/apply')
      .set('Authorization', 'Bearer ' + owner.token)
      .send({ accept: [answer.files[0].id] })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ applied: 1, rejected: 1, failed: 0 })

    const written = await File.find({ roomId: 'apply-1' })
    expect(written.map((file) => file.originalName)).toEqual(['test_add.test.js'])

    const statuses = res.body.run.files.map((file) => file.status)
    expect(statuses).toEqual(['applied', 'rejected'])
  })

  /** "None of this" is a decision, and is recorded as one. */
  it('accepts an empty decision', async () => {
    const owner = await register()
    const answer = await proposeFiles('apply-2', owner.token)

    const res = await request(app)
      .post('/api/v1/rooms/apply-2/copilot/runs/' + answer.id + '/apply')
      .set('Authorization', 'Bearer ' + owner.token)
      .send({ accept: [] })

    expect(res.body).toMatchObject({ applied: 0, rejected: 2 })
    expect(await File.countDocuments({ roomId: 'apply-2' })).toBe(0)
  })

  it('does not write the same file twice when apply is pressed again', async () => {
    const owner = await register()
    const answer = await proposeFiles('apply-3', owner.token)
    const accept = [answer.files[0].id]

    const url = '/api/v1/rooms/apply-3/copilot/runs/' + answer.id + '/apply'
    await request(app).post(url).set('Authorization', 'Bearer ' + owner.token).send({ accept })
    const second = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + owner.token)
      .send({ accept })

    expect(second.body.applied).toBe(0)
    expect(await File.countDocuments({ roomId: 'apply-3' })).toBe(1)
  })

  /**
   * Asking and acting are separate permissions. A role that may consult the
   * copilot but not add files can read the proposal and cannot take it.
   */
  it('refuses somebody who may ask but may not add files', async () => {
    const owner = await register()
    const mate = await register(GUEST)

    const answer = await proposeFiles('apply-4', owner.token)

    const room = await getRoom('apply-4')
    room.owner = owner.user.id
    room.members.push({ user: mate.user.id, role: 'editor' })
    await room.save()

    // An editor can. Demote to a role that holds copilot:use and nothing that
    // writes — there is none by default, so the check is made directly.
    room.members[0].role = 'commenter'
    await room.save()

    const res = await request(app)
      .post('/api/v1/rooms/apply-4/copilot/runs/' + answer.id + '/apply')
      .set('Authorization', 'Bearer ' + mate.token)
      .send({ accept: [answer.files[0].id] })

    expect(res.status).toBe(403)
    expect(await File.countDocuments({ roomId: 'apply-4' })).toBe(0)
  })

  it('refuses a run id belonging to another room', async () => {
    const owner = await register()
    const answer = await proposeFiles('apply-5', owner.token)
    await seedRoom('apply-6')

    const res = await request(app)
      .post('/api/v1/rooms/apply-6/copilot/runs/' + answer.id + '/apply')
      .set('Authorization', 'Bearer ' + owner.token)
      .send({ accept: [] })

    expect(res.status).toBe(404)
  })
})

/* ---------- the shared buffer ---------- */

describe('proposing a change to the code', () => {
  const FIXED = BUFFER.replace('a - b', 'a + b')

  async function proposePatch(roomId, token) {
    await seedRoom(roomId)
    modelStreams({
      answer: 'The minus should be a plus.',
      patch: { contents: FIXED, rationale: 'add() was subtracting' },
      findings: [],
      questions: [],
    })
    const frames = await ask(roomId, { action: 'execution.fix' }, token)
    return frameOf(frames, 'result').data.run
  }

  /**
   * The patch travels with the text it was written against. That is what makes
   * "never overwrite user data" a check the client can actually make rather
   * than a promise.
   */
  it('carries the buffer it was written against', async () => {
    const owner = await register()
    const answer = await proposePatch('patch-1', owner.token)

    expect(answer.patch.baseText).toBe(BUFFER)
    expect(answer.patch.contents).toBe(FIXED)
    expect(answer.patch.status).toBe('proposed')
  })

  it('offers nothing when the proposed buffer is the one already there', async () => {
    const owner = await register()
    await seedRoom('patch-2')

    modelStreams({
      answer: 'It already reads correctly.',
      patch: { contents: BUFFER, rationale: 'no change' },
      findings: [],
      questions: [],
    })

    const frames = await ask('patch-2', { action: 'execution.fix' }, owner.token)
    expect(frameOf(frames, 'result').data.run.patch).toBeNull()
  })

  it('records that a change was taken', async () => {
    const owner = await register()
    const answer = await proposePatch('patch-3', owner.token)

    const res = await request(app)
      .post('/api/v1/rooms/patch-3/copilot/runs/' + answer.id + '/patch')
      .set('Authorization', 'Bearer ' + owner.token)
      .send({ outcome: 'applied' })

    expect(res.status).toBe(200)
    expect(res.body.run.patch.status).toBe('applied')
    expect(res.body.run.patch.appliedAt).toBeTruthy()
  })

  /** The buffer moved while the model was thinking. Not a failure. */
  it('records a change refused because the buffer had moved', async () => {
    const owner = await register()
    const answer = await proposePatch('patch-4', owner.token)

    const res = await request(app)
      .post('/api/v1/rooms/patch-4/copilot/runs/' + answer.id + '/patch')
      .set('Authorization', 'Bearer ' + owner.token)
      .send({ outcome: 'stale' })

    expect(res.body.run.patch.status).toBe('stale')
    expect(res.body.run.patch.appliedAt).toBeNull()
  })

  /**
   * The model is shown the code with line endings normalised and answers in
   * whatever it likes. Without putting the buffer's own back, a file any
   * Windows editor has touched would come back entirely rewritten — every
   * line "changed", over characters nobody can see.
   */
  describe('line endings', () => {
    it('puts the buffer’s own back on the answer', () => {
      expect(matchLineEndings('a\nb\nc', 'x\r\ny')).toBe('a\r\nb\r\nc')
      expect(matchLineEndings('a\r\nb', 'x\ny')).toBe('a\nb')
    })

    it('leaves an answer that already matches alone', () => {
      expect(matchLineEndings('a\r\nb', 'x\r\ny')).toBe('a\r\nb')
      expect(matchLineEndings('a\nb', 'x\ny')).toBe('a\nb')
    })

    it('offers nothing when only the line endings differ', async () => {
      const owner = await register()
      const crlf = 'function add(a, b) {\r\n  return a - b\r\n}'
      await seedRoom('patch-6', { code: crlf })

      modelStreams({
        answer: 'No change needed.',
        // What a model shown normalised code hands back: the same program,
        // with every ending different.
        patch: { contents: crlf.replace(/\r\n/g, '\n'), rationale: 'unchanged' },
        findings: [],
        questions: [],
      })

      const frames = await ask('patch-6', { action: 'execution.fix' }, owner.token)
      expect(frameOf(frames, 'result').data.run.patch).toBeNull()
    })

    it('keeps a real change to a CRLF buffer down to the line that changed', async () => {
      const owner = await register()
      const crlf = 'function add(a, b) {\r\n  return a - b\r\n}'
      await seedRoom('patch-7', { code: crlf })

      modelStreams({
        answer: 'The minus should be a plus.',
        patch: { contents: 'function add(a, b) {\n  return a + b\n}', rationale: 'fixed' },
        findings: [],
        questions: [],
      })

      const frames = await ask('patch-7', { action: 'execution.fix' }, owner.token)
      const { patch } = frameOf(frames, 'result').data.run

      expect(patch.baseText).toBe(crlf)
      expect(patch.contents).toBe('function add(a, b) {\r\n  return a + b\r\n}')
    })
  })

  it('will not decide the same change twice', async () => {
    const owner = await register()
    const answer = await proposePatch('patch-5', owner.token)
    const url = '/api/v1/rooms/patch-5/copilot/runs/' + answer.id + '/patch'

    await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + owner.token)
      .send({ outcome: 'rejected' })

    const second = await request(app)
      .post(url)
      .set('Authorization', 'Bearer ' + owner.token)
      .send({ outcome: 'applied' })

    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('already_decided')
  })
})

/* ---------- budgets ---------- */

describe('what it costs', () => {
  /**
   * A window budget does not bound concurrency. Twenty streams opened in the
   * same second are twenty answers being paid for.
   */
  it('caps how many answers one person can have in flight', async () => {
    const owner = await register()
    await seedRoom('busy-1')

    let release
    const held = new Promise((resolve) => {
      release = resolve
    })

    /**
     * Counted rather than waited for. A slot is claimed before the model is
     * called, so `entered` reaching the cap is proof every slot is held —
     * where sleeping for a while and hoping would be a test that passes on a
     * fast machine and deadlocks on a slow one.
     */
    let entered = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      entered += 1
      await held
      return streamingResponse([
        {
          event: 'content_block_delta',
          data: {
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify({ answer: 'done', findings: [], questions: [] }),
            },
          },
        },
      ])
    })

    // `.then` rather than bare calls: a supertest request is lazy and is not
    // dispatched until something subscribes to it, so a list of unawaited
    // ones would hold no slots at all and the wait below would never end.
    const inflight = Array.from({ length: env.COPILOT_MAX_CONCURRENT }, () =>
      run('busy-1', { action: 'code.review' }, owner.token).then(
        (res) => res,
        (error) => error
      )
    )

    while (entered < env.COPILOT_MAX_CONCURRENT) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const crowded = await ask('busy-1', { action: 'code.review' }, owner.token)
    expect(frameOf(crowded, 'error').data.code).toBe('copilot_busy')

    release()
    await Promise.all(inflight)

    // And the slots are given back, so the cap is a cap and not a ratchet.
    const after = await ask('busy-1', { action: 'code.review' }, owner.token)
    expect(frameOf(after, 'result').data.run.status).toBe('succeeded')
  })
})

/* ---------- the room's record ---------- */

describe('the copilot history', () => {
  it('keeps every answer with the room data it read', async () => {
    const owner = await register()
    await seedRoom('hist-1')

    modelStreams({ answer: 'A review.', findings: [], questions: [] })
    await ask('hist-1', { action: 'code.review' }, owner.token)

    const res = await request(app)
      .get('/api/v1/rooms/hist-1/copilot/runs')
      .set('Authorization', 'Bearer ' + owner.token)

    expect(res.status).toBe(200)
    expect(res.body.runs).toHaveLength(1)
    expect(res.body.runs[0]).toMatchObject({
      actionId: 'code.review',
      context: 'code',
      requestedByName: 'Ada',
      status: 'succeeded',
    })
    expect(res.body.runs[0].sources.map((source) => source.label)).toEqual([
      'Shared code buffer',
      'Your selection',
    ])
  })

  it('reads one answer back in full', async () => {
    const owner = await register()
    await seedRoom('hist-2')

    modelStreams({ answer: 'A review.', findings: [{ title: 'A thing', severity: 'low' }], questions: [] })
    const frames = await ask('hist-2', { action: 'code.review' }, owner.token)
    const id = frameOf(frames, 'result').data.run.id

    const res = await request(app)
      .get('/api/v1/rooms/hist-2/copilot/runs/' + id)
      .set('Authorization', 'Bearer ' + owner.token)

    expect(res.body.run.result.findings[0].title).toBe('A thing')
  })

  it('refuses an id that is not one', async () => {
    const owner = await register()
    await seedRoom('hist-3')

    const res = await request(app)
      .get('/api/v1/rooms/hist-3/copilot/runs/not-an-id')
      .set('Authorization', 'Bearer ' + owner.token)

    expect(res.status).toBe(400)
  })
})

/* ---------- every action, end to end ---------- */

describe('every action in the registry', () => {
  /**
   * The framework's promise is that an action is only an entry. This presses
   * all of them: anything that needs a source that cannot be gathered, a block
   * that cannot be sanitised, or a tool schema a provider would reject shows
   * up here rather than on whichever button nobody tried.
   */
  it('answers, or refuses for a reason it declared', async () => {
    const owner = await register()
    await seedRoom('all-1', { shapes: [] })

    await Execution.create({
      executionId: 'e1',
      roomId: 'all-1',
      language: 'javascript',
      sourceHash: 'abc',
      state: 'failed',
      queuedAt: new Date(),
      stderr: 'TypeError',
      expiresAt: new Date(Date.now() + 3600_000),
    })

    for (const action of ACTIONS) {
      resetCopilotSlots()
      vi.restoreAllMocks()
      modelStreams({
        answer: 'An answer for ' + action.id + '.',
        findings: [],
        steps: [],
        tasks: [],
        comparison: [],
        questions: [],
        assumptions: [],
        citations: [],
        files: [],
      })

      const input = { action: action.id }
      if (action.needs === 'selection') Object.assign(input, { startLine: 1, endLine: 2 })
      if (action.needs === 'seq') Object.assign(input, { seq: 1 })
      if (action.needs === 'range') Object.assign(input, { fromSeq: 1, toSeq: 2 })

      const frames = await ask('all-1', input, owner.token)
      const failure = frameOf(frames, 'error')

      if (failure) {
        // The only acceptable refusal is one the action declared it needs —
        // this room has no update log, so the replay actions cannot resolve a
        // point in a history that does not exist.
        expect(action.needs, action.id + ': ' + failure.data.message).toBeTruthy()
        expect(failure.data.code, action.id).toMatch(/^(bad_seq|bad_range|needs_)/)
        continue
      }

      const { run: answer } = frameOf(frames, 'result').data
      expect(answer.status, action.id).toBe('succeeded')
      expect(answer.answer, action.id).toBe('An answer for ' + action.id + '.')
      expect(actionById(answer.actionId)).toBeTruthy()
    }
  }, 60_000)
})
