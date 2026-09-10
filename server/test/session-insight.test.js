import * as Y from 'yjs'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { env } from '../src/config/env.js'
import { DocUpdate } from '../src/models/DocUpdate.js'
import { Room } from '../src/models/Room.js'
import { resetTimelineCache } from '../src/services/session-timeline.service.js'

/**
 * Summaries that have to show their work.
 *
 * The model is stubbed at the network boundary — `fetch` — the same way the
 * code generator's tests stub it, so everything between the route and the
 * wire is real: the timeline the prompt is built from, the grounding that
 * drops statements citing nothing, the cache, and the permission checks.
 *
 * The stubbed answers are deliberately dishonest in places. A statement
 * citing an event that does not exist, and one citing nothing at all, are the
 * two ways a model invents things; both have to be caught here, not trusted.
 */

let app
let owner
let viewer
const ROOM = 'insight-room'
const T0 = new Date('2026-09-11T10:00:00.000Z').getTime()
const MIN = 60 * 1000
const savedKey = env.ANTHROPIC_API_KEY

const register = async (who) => (await request(app).post('/api/v1/auth/register').send(who)).body
const auth = (token) => ({ Authorization: 'Bearer ' + token })

let counter = 0
const id = () => 'sh' + (counter += 1)

const box = (label, x, y) => [
  { id: id(), type: 'rect', x, y, width: 120, height: 60, stroke: '#fff', strokeWidth: 2 },
  { id: id(), type: 'text', x: x + 12, y: y + 22, text: label, fontSize: 16, stroke: '#fff' },
]

const arrow = (from, to) => ({
  id: id(),
  type: 'arrow',
  x: 0,
  y: 0,
  points: [from.x, from.y, to.x, to.y],
  stroke: '#fff',
  strokeWidth: 2,
})

/** API at 00:00, Database at 01:00, connected at 02:00 — three events, e1 to e3. */
async function recordHistory(actor) {
  const doc = new Y.Doc()
  const rows = []
  const steps = [
    { at: 0, apply: (d) => d.getArray('shapes').push(box('API', 0, 0)) },
    { at: MIN, apply: (d) => d.getArray('shapes').push(box('Database', 300, 0)) },
    { at: 2 * MIN, apply: (d) => d.getArray('shapes').push([arrow({ x: 120, y: 30 }, { x: 300, y: 30 })]) },
  ]

  let seq = 0
  for (const step of steps) {
    const updates = []
    const collect = (update) => updates.push(update)
    doc.on('update', collect)
    doc.transact(() => step.apply(doc))
    doc.off('update', collect)
    for (const update of updates) {
      seq += 1
      rows.push({
        roomId: ROOM,
        seq,
        update: Buffer.from(update),
        actor,
        size: update.byteLength,
        createdAt: new Date(T0 + step.at),
      })
    }
  }

  await DocUpdate.collection.insertMany(rows)
  doc.destroy()
}

/** A model that answers once, through the forced tool, with `input`. */
function modelAnswers(tool, input) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', name: tool, input }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    text: () => Promise.resolve(''),
  })
}

const EMPTY = { decisions: [], code: [], failed: [], succeeded: [], unresolved: [], collaboration: [] }

const SUMMARY = {
  ...EMPTY,
  overview: { text: 'An API and a database were drawn and connected.', events: ['e1', 'e2', 'e3'] },
  architecture: [
    { text: 'An API was added first.', events: ['e1'] },
    // Invented: there is no e999, and there was never a payment gateway.
    { text: 'A payment gateway was added.', events: ['e999'] },
    // Invented differently: no evidence offered at all.
    { text: 'The team chose PostgreSQL.', events: [] },
  ],
}

beforeAll(startMemoryMongo)
afterAll(async () => {
  env.ANTHROPIC_API_KEY = savedKey
  await stopMemoryMongo()
})

beforeEach(async () => {
  await clearDatabase()
  resetTimelineCache()
  env.ANTHROPIC_API_KEY = 'sk-ant-test'
  env.AI_ENABLED = true
  app = createApp()

  owner = await register({ email: 'ada@insight.test', password: 'owner-passphrase-1', name: 'Ada' })
  viewer = await register({ email: 'vic@insight.test', password: 'viewer-passphrase-1', name: 'Vic' })

  await Room.create({
    roomId: ROOM,
    name: 'Design review',
    owner: owner.user.id,
    isPublic: false,
    members: [
      { user: owner.user.id, role: 'owner' },
      { user: viewer.user.id, role: 'viewer' },
    ],
  })

  await recordHistory(owner.user.id)
})

afterEach(() => vi.restoreAllMocks())

describe('the timeline behind every summary', () => {
  it('is readable with replay access alone, and involves no model', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await request(app).get('/api/v1/rooms/' + ROOM + '/history/timeline').set(auth(viewer.token))

    expect(res.status).toBe(200)
    expect(res.body.timeline.events.map((event) => event.id + ' ' + event.clock + ' ' + event.text)).toEqual([
      'e1 00:00 API added',
      'e2 01:00 Database added',
      'e3 02:00 API connected to Database',
    ])
    expect(res.body.timeline.segments).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('summarising a session', () => {
  it('keeps only what the events support, and says how much it dropped', async () => {
    const fetchSpy = modelAnswers('summarize_session', SUMMARY)

    const res = await request(app)
      .post('/api/v1/rooms/' + ROOM + '/history/summary')
      .set(auth(owner.token))
      .send({})

    expect(res.status).toBe(200)
    const { summary } = res.body

    expect(summary.sections.architecture).toEqual([{ text: 'An API was added first.', events: ['e1'] }])
    expect(summary.discarded).toBe(2)
    expect(summary.sections.overview.events).toEqual(['e1', 'e2', 'e3'])

    // The events it cites travel with it, so it can always show its evidence.
    expect(summary.cited.e1).toMatchObject({ clock: '00:00', text: 'API added' })

    // The model was shown the timeline, and forced to answer through the tool.
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'summarize_session' })
    expect(body.messages[0].content).toContain('e1  00:00  architecture.added  Ada: API added [api]')
    expect(body.system).toContain('Every statement must cite at least one event id')
  })

  /** Asking twice about a history that has not changed costs one model call. */
  it('answers from the cache while nothing has changed', async () => {
    const fetchSpy = modelAnswers('summarize_session', SUMMARY)
    const ask = () =>
      request(app).post('/api/v1/rooms/' + ROOM + '/history/summary').set(auth(owner.token)).send({})

    expect((await ask()).body.cached).toBe(false)
    expect((await ask()).body.cached).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('lets a viewer read a summary but not pay for one', async () => {
    modelAnswers('summarize_session', SUMMARY)
    await request(app).post('/api/v1/rooms/' + ROOM + '/history/summary').set(auth(owner.token)).send({})

    const read = await request(app).get('/api/v1/rooms/' + ROOM + '/history/summary').set(auth(viewer.token))
    expect(read.status).toBe(200)
    expect(read.body.current).toBe(true)
    expect(read.body.summary.sections.architecture).toHaveLength(1)

    const write = await request(app)
      .post('/api/v1/rooms/' + ROOM + '/history/summary')
      .set(auth(viewer.token))
      .send({})
    expect(write.status).toBe(403)
  })

  it('reads as out of date once the room has moved on', async () => {
    modelAnswers('summarize_session', SUMMARY)
    await request(app).post('/api/v1/rooms/' + ROOM + '/history/summary').set(auth(owner.token)).send({})

    await DocUpdate.collection.insertOne({
      roomId: ROOM,
      seq: 99,
      update: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())),
      actor: null,
      size: 2,
      createdAt: new Date(T0 + 10 * MIN),
    })

    const read = await request(app).get('/api/v1/rooms/' + ROOM + '/history/summary').set(auth(owner.token))
    expect(read.body.current).toBe(false)
  })

  it('refuses before calling a model when none is configured', async () => {
    env.ANTHROPIC_API_KEY = undefined
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await request(app)
      .post('/api/v1/rooms/' + ROOM + '/history/summary')
      .set(auth(owner.token))
      .send({})

    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('ai_disabled')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('needs an account, so the spend is attributable', async () => {
    const res = await request(app).post('/api/v1/rooms/' + ROOM + '/history/summary').send({})
    expect(res.status).toBe(401)
  })
})

describe('explaining a moment', () => {
  it('describes the point paused on, citing the change there as "now"', async () => {
    const fetchSpy = modelAnswers('explain_moment', {
      explanation: { text: 'The API box was drawn.', events: ['now', 'e1'] },
      context: [],
      next: [
        { text: 'A database followed a minute later.', events: ['e2'] },
        { text: 'Then a cache was added.', events: ['e42'] },
      ],
    })

    const res = await request(app)
      .post('/api/v1/rooms/' + ROOM + '/history/explain')
      .set(auth(owner.token))
      .send({ seq: 1 })

    expect(res.status).toBe(200)
    const { moment } = res.body

    expect(moment.explanation.events).toEqual(['now', 'e1'])
    expect(moment.next).toEqual([{ text: 'A database followed a minute later.', events: ['e2'] }])
    expect(moment.discarded).toBe(1)
    expect(moment.cited.now.detail).toContain('API added')

    // The exact change at this point is in the prompt, labelled "now".
    const prompt = JSON.parse(fetchSpy.mock.calls[0][1].body).messages[0].content
    expect(prompt).toContain('now  00:00  moment.change')
    expect(prompt).toContain('API added (api)')
  })

  it('rejects a position that is not in the history', async () => {
    const res = await request(app)
      .post('/api/v1/rooms/' + ROOM + '/history/explain')
      .set(auth(owner.token))
      .send({ seq: 9999 })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_seq')
  })
})
