import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { env } from '../src/config/env.js'
import { File } from '../src/models/File.js'
import { Generation } from '../src/models/Generation.js'
import { Snapshot } from '../src/models/Snapshot.js'
import { ensureRoom } from '../src/services/room.service.js'
import * as Y from 'yjs'

/**
 * Whiteboard to code, over HTTP.
 *
 * The model is stubbed at the network boundary — `fetch` — rather than by
 * mocking the service that calls it, so everything the server actually does
 * with an answer is exercised: the sanitising, the create-versus-modify
 * decision, the record, and the apply.
 *
 * The decision worth watching hardest is that one. The model never sees the
 * room's files, so its own `action` is a guess; the server overrules it. A
 * regression there is how "generate" quietly becomes "overwrite".
 */

let app

const ALICE = { email: 'alice@syncspace.test', password: 'correct-horse-battery', name: 'Alice' }
const BOB = { email: 'bob@syncspace.test', password: 'a-different-passphrase', name: 'Bob' }

const key = env.ANTHROPIC_API_KEY
const enabled = env.AI_ENABLED

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

beforeEach(async () => {
  await clearDatabase()
  app = createApp()
  env.ANTHROPIC_API_KEY = 'sk-ant-test'
  env.AI_ENABLED = true
})

afterEach(() => {
  env.ANTHROPIC_API_KEY = key
  env.AI_ENABLED = enabled
  vi.restoreAllMocks()
})

const register = async (who = ALICE) => {
  const res = await request(app).post('/api/v1/auth/register').send(who)
  expect(res.status).toBe(201)
  return res.body
}

/**
 * Puts shapes into a room the way a snapshot would, with no live document.
 *
 * The room record is created too. Generating uses `ensureRoom` and would make
 * one on the way past, but uploading a file does not — so a test that put a
 * file in first was asking about a room that did not exist yet.
 */
async function drawRoom(roomId, shapes) {
  await ensureRoom(roomId)

  const doc = new Y.Doc()
  const array = doc.getArray('shapes')
  array.push(
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

let shapeCounter = 0
const nextId = () => 'sh' + (shapeCounter += 1)

const labelledBox = (label, x, y) => [
  { id: nextId(), type: 'rect', x, y, width: 140, height: 60, stroke: '#fff', strokeWidth: 2, authorName: 'Ada' },
  { id: nextId(), type: 'text', x: x + 10, y: y + 20, text: label, fontSize: 16, stroke: '#fff', strokeWidth: 0, authorName: 'Ada' },
]

const connector = (fromY, toY) => ({
  id: nextId(),
  type: 'arrow',
  x: 0,
  y: 0,
  points: [70, fromY, 70, toY],
  stroke: '#fff',
  strokeWidth: 2,
  authorName: 'Ada',
})

/** The diagram from the brief. */
const CLIENT_API_AUTH_DB = [
  ...labelledBox('Client', 0, 0),
  ...labelledBox('API', 0, 200),
  ...labelledBox('Auth Service', 0, 400),
  ...labelledBox('Database', 0, 600),
  connector(60, 200),
  connector(260, 400),
  connector(460, 600),
]

/** Stubs the model at the network boundary. */
function modelAnswers(files, extra = {}) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        model: 'claude-sonnet-5',
        usage: { input_tokens: 100, output_tokens: 500 },
        content: [
          {
            type: 'tool_use',
            name: 'propose_implementation',
            input: {
              summary: 'A four-tier web application.',
              plan: [{ step: 'Model the data', detail: 'Start with the schema' }],
              assumptions: ['PostgreSQL, because the diagram says "Database" and nothing more'],
              questions: ['Which identity provider should Auth Service use?'],
              files,
              ...extra,
            },
          },
        ],
      }),
    text: () => Promise.resolve('{}'),
  })
}

/**
 * Puts a text file in a room.
 *
 * The content type is set explicitly and the result asserted, because neither
 * is incidental: supertest infers `application/octet-stream` for a `.js`
 * attachment, the upload filter refuses it, and a test that skipped the
 * assertion would go on to "prove" that an existing file is treated as new —
 * having never created one. Generated files are applied as `text/plain`,
 * which is what makes this the same path.
 */
const uploadText = async (token, roomId, name, contents) => {
  const res = await request(app)
    .post('/api/v1/rooms/' + roomId + '/files')
    .set('Authorization', 'Bearer ' + token)
    .attach('file', Buffer.from(contents), { filename: name, contentType: 'text/plain' })

  expect(res.status).toBe(201)
  return res.body
}

const generate = (token, roomId, body = { targets: ['backend'] }) =>
  request(app)
    .post('/api/v1/rooms/' + roomId + '/generate')
    .set('Authorization', 'Bearer ' + token)
    .send(body)

describe('GET /rooms/:roomId/architecture', () => {
  it('reads the design off the board without going near a model', async () => {
    const { token } = await register()
    await drawRoom('arch1', CLIENT_API_AUTH_DB)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await request(app)
      .get('/api/v1/rooms/arch1/architecture')
      .set('Authorization', 'Bearer ' + token)

    expect(res.status).toBe(200)
    expect(res.body.architecture.nodes.map((n) => n.label)).toEqual([
      'Client',
      'API',
      'Auth Service',
      'Database',
    ])
    expect(res.body.architecture.edges).toHaveLength(3)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('says what it could not read', async () => {
    const { token } = await register()
    await drawRoom('arch2', [...labelledBox('A', 0, 0), connector(60, 9000)])

    const res = await request(app)
      .get('/api/v1/rooms/arch2/architecture')
      .set('Authorization', 'Bearer ' + token)

    expect(res.body.architecture.warnings.some((w) => w.code === 'dangling_connector')).toBe(true)
  })

  it('is empty rather than broken for a room nobody has drawn on', async () => {
    const { token } = await register()

    const res = await request(app)
      .get('/api/v1/rooms/blank/architecture')
      .set('Authorization', 'Bearer ' + token)

    expect(res.status).toBe(200)
    expect(res.body.architecture.nodes).toEqual([])
    expect(res.body.architecture.warnings.some((w) => w.code === 'no_components')).toBe(true)
  })
})

describe('POST /rooms/:roomId/generate', () => {
  it('needs an account, not just room access', async () => {
    await drawRoom('gen1', CLIENT_API_AUTH_DB)
    const res = await request(app).post('/api/v1/rooms/gen1/generate').send({ targets: ['backend'] })
    expect(res.status).toBe(401)
  })

  it('says so when no model is configured, instead of failing obscurely', async () => {
    const { token } = await register()
    env.ANTHROPIC_API_KEY = undefined
    await drawRoom('gen2', CLIENT_API_AUTH_DB)

    const res = await generate(token, 'gen2')

    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('ai_disabled')
    expect(res.body.error.message).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('refuses an unknown target', async () => {
    const { token } = await register()
    const res = await generate(token, 'gen3', { targets: ['telepathy'] })
    expect(res.status).toBe(400)
  })

  it('produces a change set from the diagram', async () => {
    const { token } = await register()
    await drawRoom('gen4', CLIENT_API_AUTH_DB)
    const fetchSpy = modelAnswers([
      { path: 'src/models/user.js', action: 'create', contents: 'export const User = {}\n', language: 'javascript' },
      { path: 'src/api/auth.js', action: 'create', contents: 'export const login = () => {}\n' },
    ])

    const res = await generate(token, 'gen4', { targets: ['backend', 'database'] })

    expect(res.status).toBe(201)
    expect(res.body.generation.files).toHaveLength(2)
    expect(res.body.generation.files.every((f) => f.status === 'proposed')).toBe(true)
    expect(res.body.generation.assumptions).toHaveLength(1)
    expect(res.body.generation.questions).toHaveLength(1)
    expect(res.body.generation.counts).toMatchObject({ create: 2, modify: 0, delete: 0 })

    // The prompt carried the graph, not the drawing.
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.messages[0].content).toContain('auth-service -> database')
  })

  it('records the architecture it was answering', async () => {
    const { token } = await register()
    await drawRoom('gen5', CLIENT_API_AUTH_DB)
    modelAnswers([{ path: 'a.js', action: 'create', contents: 'x' }])

    const res = await generate(token, 'gen5')

    expect(res.body.generation.architecture.nodes).toHaveLength(4)
    expect(res.body.generation.architecture.edges).toHaveLength(3)
  })

  it('writes nothing into the room', async () => {
    const { token } = await register()
    await drawRoom('gen6', CLIENT_API_AUTH_DB)
    modelAnswers([{ path: 'src/a.js', action: 'create', contents: 'x' }])

    await generate(token, 'gen6')

    expect(await File.countDocuments({ roomId: 'gen6' })).toBe(0)
  })

  it('keeps a failed generation in the room history rather than losing it', async () => {
    const { token } = await register()
    await drawRoom('gen7', CLIENT_API_AUTH_DB)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('upstream exploded'),
    })

    const res = await generate(token, 'gen7')

    expect(res.status).toBe(502)
    const stored = await Generation.find({ roomId: 'gen7' })
    expect(stored).toHaveLength(1)
    expect(stored[0].status).toBe('failed')
  })

  it('refuses someone who is not in a private room', async () => {
    const alice = await register(ALICE)
    const bob = await register(BOB)

    const room = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + alice.token)
      .send({ name: 'Private' })

    modelAnswers([{ path: 'a.js', action: 'create', contents: 'x' }])

    const res = await generate(bob.token, room.body.room.roomId)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('room_forbidden')
  })
})

describe('what the server decides, not the model', () => {
  /**
   * The model has never seen the room's files, so "create" from it means "I
   * wrote a new file" — not "this name is free". Taking it at its word is how
   * a generation would silently replace somebody's work.
   */
  it('turns a create onto an existing name into a modify', async () => {
    const { token } = await register()
    await drawRoom('rec1', CLIENT_API_AUTH_DB)

    await uploadText(token, 'rec1', 'src_index.js', 'the original\n')

    modelAnswers([{ path: 'src/index.js', action: 'create', contents: 'replacement\n' }])

    const res = await generate(token, 'rec1')
    const [file] = res.body.generation.files

    expect(file.action).toBe('modify')
    expect(res.body.generation.rejected.join(' ')).toMatch(/already exists/i)
  })

  /** And it arrives carrying what it would replace, so it can be read first. */
  it('sends the current contents alongside a modification', async () => {
    const { token } = await register()
    await drawRoom('rec2', CLIENT_API_AUTH_DB)

    await uploadText(token, 'rec2', 'src_index.js', 'the original\n')

    modelAnswers([{ path: 'src/index.js', action: 'modify', contents: 'replacement\n' }])

    const res = await generate(token, 'rec2')
    expect(res.body.generation.files[0].previous).toBe('the original\n')
  })

  /**
   * Reopened tomorrow, the comparison is against the file as it stands then —
   * not as it stood when the model answered. If somebody edited it in
   * between, that is exactly what the reviewer needs to see.
   */
  it('recomputes the comparison when a change set is reopened', async () => {
    const { token } = await register()
    await drawRoom('rec6', CLIENT_API_AUTH_DB)
    await uploadText(token, 'rec6', 'src_index.js', 'first\n')

    modelAnswers([{ path: 'src/index.js', action: 'modify', contents: 'proposed\n' }])
    const created = await generate(token, 'rec6')
    expect(created.body.generation.files[0].previous).toBe('first\n')

    // Somebody replaces the file after the change set was produced.
    const existing = await File.findOne({ roomId: 'rec6' }).lean()
    await request(app)
      .delete('/api/v1/rooms/rec6/files/' + existing._id)
      .set('Authorization', 'Bearer ' + token)
    await uploadText(token, 'rec6', 'src_index.js', 'second\n')

    const reopened = await request(app)
      .get('/api/v1/rooms/rec6/generations/' + created.body.generation.id)
      .set('Authorization', 'Bearer ' + token)

    expect(reopened.body.generation.files[0].previous).toBe('second\n')
  })

  it('turns a modify of a file that does not exist into a create', async () => {
    const { token } = await register()
    await drawRoom('rec3', CLIENT_API_AUTH_DB)
    modelAnswers([{ path: 'src/new.js', action: 'modify', contents: 'x' }])

    const res = await generate(token, 'rec3')

    expect(res.body.generation.files[0].action).toBe('create')
    expect(res.body.generation.files[0].previous).toBeNull()
  })

  it('drops a proposed deletion of a file the room does not have', async () => {
    const { token } = await register()
    await drawRoom('rec4', CLIENT_API_AUTH_DB)
    modelAnswers([{ path: 'src/gone.js', action: 'delete' }])

    const res = await generate(token, 'rec4')

    expect(res.body.generation.files).toHaveLength(0)
    expect(res.body.generation.rejected.join(' ')).toMatch(/no copy of/i)
  })

  it('keeps two files whose names would otherwise collapse together', async () => {
    const { token } = await register()
    await drawRoom('rec5', CLIENT_API_AUTH_DB)
    modelAnswers([
      { path: 'src/api/index.js', action: 'create', contents: 'a' },
      { path: 'src/db/index.js', action: 'create', contents: 'b' },
    ])

    const res = await generate(token, 'rec5')

    expect(res.body.generation.files).toHaveLength(2)
    const ids = res.body.generation.files.map((f) => f.id)
    await request(app)
      .post('/api/v1/rooms/rec5/generations/' + res.body.generation.id + '/apply')
      .set('Authorization', 'Bearer ' + token)
      .send({ accept: ids })

    const names = (await File.find({ roomId: 'rec5' }).lean()).map((f) => f.originalName).sort()
    expect(names).toEqual(['src_api_index.js', 'src_db_index.js'])
  })
})

describe('applying a change set', () => {
  const setUp = async (roomId, files) => {
    const { token } = await register()
    await drawRoom(roomId, CLIENT_API_AUTH_DB)
    modelAnswers(files)
    const res = await generate(token, roomId)
    return { token, generation: res.body.generation }
  }

  const apply = (token, roomId, id, accept) =>
    request(app)
      .post('/api/v1/rooms/' + roomId + '/generations/' + id + '/apply')
      .set('Authorization', 'Bearer ' + token)
      .send({ accept })

  it('writes the accepted files into the room', async () => {
    const { token, generation } = await setUp('ap1', [
      { path: 'src/a.js', action: 'create', contents: 'const a = 1\n' },
    ])

    const res = await apply(token, 'ap1', generation.id, [generation.files[0].id])

    expect(res.status).toBe(200)
    expect(res.body.applied).toBe(1)
    expect(await File.countDocuments({ roomId: 'ap1' })).toBe(1)
    expect(res.body.generation.files[0].status).toBe('applied')
    expect(res.body.generation.files[0].appliedFileId).toEqual(expect.any(String))
  })

  /** The point of a change set: take some of it. */
  it('applies only what was accepted and rejects the rest', async () => {
    const { token, generation } = await setUp('ap2', [
      { path: 'src/keep.js', action: 'create', contents: 'keep\n' },
      { path: 'src/skip.js', action: 'create', contents: 'skip\n' },
      { path: 'src/also-skip.js', action: 'create', contents: 'skip\n' },
    ])
    const keep = generation.files.find((f) => f.path === 'src/keep.js')

    const res = await apply(token, 'ap2', generation.id, [keep.id])

    expect(res.body).toMatchObject({ applied: 1, rejected: 2, failed: 0 })

    const written = await File.find({ roomId: 'ap2' }).lean()
    expect(written.map((f) => f.originalName)).toEqual(['src_keep.js'])

    const statuses = res.body.generation.files.map((f) => f.status).sort()
    expect(statuses).toEqual(['applied', 'rejected', 'rejected'])
  })

  /**
   * A change set with nothing recorded against it is worse than either
   * answer, because nothing can tell "not looked at" from "declined".
   */
  it('records a decision even when nothing is accepted', async () => {
    const { token, generation } = await setUp('ap3', [
      { path: 'src/a.js', action: 'create', contents: 'a' },
    ])

    const res = await apply(token, 'ap3', generation.id, [])

    expect(res.body).toMatchObject({ applied: 0, rejected: 1 })
    expect(res.body.generation.files[0].status).toBe('rejected')
    expect(await File.countDocuments({ roomId: 'ap3' })).toBe(0)
  })

  it('replaces the file a modification was reviewed against', async () => {
    const { token } = await register()
    await drawRoom('ap4', CLIENT_API_AUTH_DB)

    await uploadText(token, 'ap4', 'src_index.js', 'old\n')

    modelAnswers([{ path: 'src/index.js', action: 'modify', contents: 'new\n' }])
    const res = await generate(token, 'ap4')

    await apply(token, 'ap4', res.body.generation.id, [res.body.generation.files[0].id])

    const files = await File.find({ roomId: 'ap4' }).lean()
    // One file, not two: a modification replaces rather than piles up.
    expect(files).toHaveLength(1)
    expect(files[0].originalName).toBe('src_index.js')
    expect(files[0].size).toBe(4)
  })

  it('does not apply the same file twice', async () => {
    const { token, generation } = await setUp('ap5', [
      { path: 'src/a.js', action: 'create', contents: 'a' },
    ])
    const id = generation.files[0].id

    await apply(token, 'ap5', generation.id, [id])
    const second = await apply(token, 'ap5', generation.id, [id])

    expect(second.body.applied).toBe(0)
    expect(await File.countDocuments({ roomId: 'ap5' })).toBe(1)
  })

  it('refuses a file id that belongs to no change set', async () => {
    const { token, generation } = await setUp('ap6', [
      { path: 'src/a.js', action: 'create', contents: 'a' },
    ])

    const res = await apply(token, 'ap6', generation.id, ['507f1f77bcf86cd799439011'])

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('unknown_file')
  })

  it('will not reach a generation belonging to another room', async () => {
    const { token, generation } = await setUp('ap7', [
      { path: 'src/a.js', action: 'create', contents: 'a' },
    ])

    const res = await request(app)
      .get('/api/v1/rooms/somewhere-else/generations/' + generation.id)
      .set('Authorization', 'Bearer ' + token)

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('generation_not_found')
  })
})

describe('the room AI timeline', () => {
  it('lists generations newest first, failures included', async () => {
    const { token } = await register()
    await drawRoom('tl1', CLIENT_API_AUTH_DB)

    modelAnswers([{ path: 'src/a.js', action: 'create', contents: 'a' }])
    await generate(token, 'tl1')

    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    })
    await generate(token, 'tl1')

    const res = await request(app)
      .get('/api/v1/rooms/tl1/generations')
      .set('Authorization', 'Bearer ' + token)

    expect(res.status).toBe(200)
    expect(res.body.generations).toHaveLength(2)
    expect(res.body.generations[0].status).toBe('failed')
    expect(res.body.generations[1].status).toBe('succeeded')
  })

  it('says who asked and what for', async () => {
    const { token } = await register()
    await drawRoom('tl2', CLIENT_API_AUTH_DB)
    modelAnswers([{ path: 'src/a.js', action: 'create', contents: 'a' }])

    await generate(token, 'tl2', { targets: ['backend', 'frontend'] })

    const res = await request(app)
      .get('/api/v1/rooms/tl2/generations')
      .set('Authorization', 'Bearer ' + token)

    expect(res.body.generations[0].requestedByName).toBe('Alice')
    expect(res.body.generations[0].targets).toEqual(['backend', 'frontend'])
  })

  it('keeps the list out of a stranger\'s hands', async () => {
    const alice = await register(ALICE)
    const bob = await register(BOB)

    const room = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', 'Bearer ' + alice.token)
      .send({ name: 'Private' })

    const res = await request(app)
      .get('/api/v1/rooms/' + room.body.room.roomId + '/generations')
      .set('Authorization', 'Bearer ' + bob.token)

    expect(res.status).toBe(403)
  })
})

describe('GET /ai', () => {
  it('reports availability and the targets on offer', async () => {
    const res = await request(app).get('/api/v1/ai')

    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(true)
    expect(res.body.targets.map((t) => t.key)).toEqual(['backend', 'api', 'database', 'frontend'])
  })

  it('explains itself when switched off, and never names the key', async () => {
    env.ANTHROPIC_API_KEY = 'sk-ant-secret'
    env.AI_ENABLED = false

    const res = await request(app).get('/api/v1/ai')

    expect(res.body.enabled).toBe(false)
    expect(res.body.reason).toMatch(/switched off/i)
    expect(JSON.stringify(res.body)).not.toContain('secret')
  })
})
