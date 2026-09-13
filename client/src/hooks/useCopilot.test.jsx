import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { useCopilot } from './useCopilot.js'
import { setAuthToken } from '../api/client.js'

/**
 * An answer arriving a piece at a time, and what counts as it having arrived.
 *
 * The case worth testing hardest is the stream that simply stops. A dropped
 * connection produces no error frame and no result — it looks, from inside the
 * loop, exactly like a stream that finished. Reporting that as success would
 * leave somebody reading half an answer with no sign that it is half.
 */

const ROOM = 'MSTTPQuJ'

const CATALOGUE = {
  enabled: true,
  allowed: true,
  reason: null,
  runs: 2,
  contexts: [{ id: 'code', label: 'Code', icon: 'code', detail: 'The shared buffer' }],
  actions: [
    { id: 'code.review', context: 'code', title: 'Review', detail: 'A review', icon: 'eye', sources: ['code'], produces: ['answer'], needs: null, apply: null },
  ],
}

const run = (extra = {}) => ({
  id: '65f0000000000000000000a1',
  roomId: ROOM,
  actionId: 'code.review',
  context: 'code',
  status: 'succeeded',
  answer: 'The parser does not handle an empty file.',
  sources: [{ key: 'code', label: 'Shared code buffer', detail: '12 lines', present: true }],
  result: { answer: 'The parser does not handle an empty file.', findings: [] },
  files: [],
  patch: null,
  rejected: [],
  discarded: 0,
  counts: { files: 0, applied: 0, patch: null },
  createdAt: new Date().toISOString(),
  ...extra,
})

const json = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) })

/** A fetch answer whose body reads back as the given event-stream frames. */
function stream(frames) {
  const encoder = new TextEncoder()
  const chunks = frames.map(
    ([event, data]) => encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')
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
      }),
    },
  }
}

/**
 * Routes each request by URL, so a test says what the server does rather than
 * counting calls in order.
 */
function server({ onRun, history = [], catalogue = CATALOGUE, ...rest } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const path = String(url)

    if (path.endsWith('/copilot')) return json(catalogue)
    if (path.endsWith('/copilot/runs') && options?.method === 'POST') return onRun(options)
    if (path.endsWith('/copilot/runs')) return json({ runs: history })
    if (path.endsWith('/apply')) return json(rest.apply)
    if (path.endsWith('/patch')) return json(rest.patch)
    if (path.includes('/copilot/runs/')) return json({ run: rest.one })

    throw new Error('unexpected request: ' + path)
  })
}

const ready = async (result) => {
  await waitFor(() => expect(result.current.catalogue.state).toBe('ready'))
}

beforeEach(() => setAuthToken('test-token'))

describe('useCopilot', () => {
  it('asks what the copilot can do here, once', async () => {
    const fetchSpy = server({ onRun: () => stream([]) })
    const { result } = renderHook(() => useCopilot(ROOM))

    await ready(result)
    expect(result.current.catalogue.data.actions).toHaveLength(1)

    const catalogueCalls = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/copilot'))
    expect(catalogueCalls).toHaveLength(1)
  })

  it('shows the sources before a word of the answer', async () => {
    const sources = [{ key: 'code', label: 'Shared code buffer', detail: '12 lines', present: true }]

    server({
      onRun: () =>
        stream([
          ['sources', { action: 'code.review', sources }],
          ['delta', { text: 'The parser ' }],
          ['delta', { text: 'is fine.' }],
          ['result', { run: run({ answer: 'The parser is fine.' }) }],
          ['done', {}],
        ]),
    })

    const { result } = renderHook(() => useCopilot(ROOM))
    await ready(result)

    await act(async () => {
      await result.current.ask({ action: 'code.review' })
    })

    expect(result.current.current.sources).toEqual(sources)
  })

  /**
   * Held open half way through, because the point is what the panel shows
   * while an answer is still being written — a version of this that let the
   * stream finish first would only be testing the end of it.
   */
  it('builds the answer out of the pieces as they arrive', async () => {
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })

    const encoder = new TextEncoder()
    const frame = (event, data) =>
      encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')

    const queued = [frame('delta', { text: 'One. ' }), frame('delta', { text: 'Two. ' })]
    const rest = [frame('result', { run: run({ answer: 'One. Two. Three.' }) })]

    server({
      onRun: () => ({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              if (queued.length) return { done: false, value: queued.shift() }
              await held
              if (rest.length) return { done: false, value: rest.shift() }
              return { done: true }
            },
            releaseLock: () => {},
          }),
        },
      }),
    })

    const { result } = renderHook(() => useCopilot(ROOM))
    await ready(result)

    let asking
    act(() => {
      asking = result.current.ask({ action: 'code.review' })
    })

    // Half written, and readable.
    await waitFor(() => expect(result.current.current.text).toBe('One. Two. '))
    expect(result.current.current.state).toBe('streaming')
    expect(result.current.current.run).toBeNull()

    await act(async () => {
      release()
      await asking
    })

    expect(result.current.current.state).toBe('done')
    expect(result.current.current.run.answer).toBe('One. Two. Three.')
  })

  /**
   * The reason the result frame is what counts. A connection that drops mid
   * answer produces neither a result nor an error, and would otherwise be
   * indistinguishable from success.
   */
  it('treats a stream that stops without a result as a failure', async () => {
    const errors = []

    server({
      onRun: () => stream([['delta', { text: 'half an ans' }]]),
    })

    const { result } = renderHook(() =>
      useCopilot(ROOM, { onError: (message) => errors.push(message) })
    )
    await ready(result)

    await act(async () => {
      await result.current.ask({ action: 'code.review' })
    })

    expect(result.current.current.state).toBe('error')
    expect(result.current.current.run).toBeNull()
    expect(errors[0]).toMatch(/stopped before it was finished/)
    // What did arrive is kept on screen rather than blanked: half an answer
    // with a warning beats an empty panel.
    expect(result.current.current.text).toBe('half an ans')
  })

  it('reports what an error frame said', async () => {
    server({
      onRun: () =>
        stream([
          ['error', { code: 'ai_unavailable', message: 'The model is busy right now.' }],
          ['done', {}],
        ]),
    })

    const { result } = renderHook(() => useCopilot(ROOM))
    await ready(result)

    await act(async () => {
      await result.current.ask({ action: 'code.review' })
    })

    expect(result.current.current.error).toBe('The model is busy right now.')
  })

  /** A refusal arrives before the stream opens, as an ordinary status code. */
  it('reports a refusal the server made before streaming anything', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (String(url).endsWith('/copilot')) return json(CATALOGUE)
      if (String(url).endsWith('/copilot/runs') && options?.method === 'POST') {
        return {
          ok: false,
          status: 403,
          json: () =>
            Promise.resolve({
              error: { code: 'copilot_forbidden', message: 'Your role does not include the copilot' },
            }),
        }
      }
      return json({ runs: [] })
    })

    const { result } = renderHook(() => useCopilot(ROOM))
    await ready(result)

    await act(async () => {
      await result.current.ask({ action: 'code.review' })
    })

    expect(result.current.current.error).toMatch(/does not include the copilot/)
  })

  it('stops an answer that is still arriving, without calling it a success', async () => {
    server({ onRun: () => new Promise(() => {}) })

    const { result } = renderHook(() => useCopilot(ROOM))
    await ready(result)

    act(() => {
      result.current.ask({ action: 'code.review' })
    })

    await waitFor(() => expect(result.current.current.state).toBe('streaming'))

    act(() => result.current.stop())

    expect(result.current.current.state).toBe('error')
    expect(result.current.current.error).toMatch(/stopped this answer/)
  })
})

describe('deciding what to do with an answer', () => {
  const withPatch = (base, contents) =>
    run({
      patch: { contents, rationale: 'add() was subtracting', baseText: base, status: 'proposed' },
    })

  const buffer = (text) => {
    const doc = new Y.Doc()
    const yText = doc.getText('code')
    yText.insert(0, text)
    return yText
  }

  it('applies a change to the buffer and records that it was taken', async () => {
    const base = 'return a - b'
    const next = 'return a + b'

    server({
      onRun: () => stream([['result', { run: withPatch(base, next) }]]),
      patch: { run: withPatch(base, next) },
    })

    const { result } = renderHook(() => useCopilot(ROOM))
    await ready(result)
    await act(async () => {
      await result.current.ask({ action: 'execution.fix' })
    })

    const yText = buffer(base)
    let outcome
    await act(async () => {
      outcome = await result.current.applyCode(yText)
    })

    expect(outcome).toEqual({ applied: true, reason: null })
    expect(yText.toString()).toBe(next)
  })

  /**
   * The case the whole path exists for. Somebody typed while the model was
   * thinking, so the approval was for text that is no longer there.
   */
  it('refuses to apply over editing done while the model was thinking', async () => {
    const base = 'return a - b'
    const errors = []

    server({
      onRun: () => stream([['result', { run: withPatch(base, 'return a + b') }]]),
      patch: { run: withPatch(base, 'return a + b') },
    })

    const { result } = renderHook(() =>
      useCopilot(ROOM, { onError: (message) => errors.push(message) })
    )
    await ready(result)
    await act(async () => {
      await result.current.ask({ action: 'execution.fix' })
    })

    const yText = buffer('return a - b // and something else')
    let outcome
    await act(async () => {
      outcome = await result.current.applyCode(yText)
    })

    expect(outcome).toEqual({ applied: false, reason: 'stale' })
    expect(yText.toString()).toBe('return a - b // and something else')
    expect(errors[0]).toMatch(/changed while the copilot was thinking/)
  })

  it('reports the refusal to the server as stale, not as a rejection', async () => {
    const base = 'return a - b'
    const fetchSpy = server({
      onRun: () => stream([['result', { run: withPatch(base, 'return a + b') }]]),
      patch: { run: withPatch(base, 'return a + b') },
    })

    const { result } = renderHook(() => useCopilot(ROOM, { onError: () => {} }))
    await ready(result)
    await act(async () => {
      await result.current.ask({ action: 'execution.fix' })
    })

    await act(async () => {
      await result.current.applyCode(buffer('something else entirely'))
    })

    const patchCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/patch'))
    expect(JSON.parse(patchCall[1].body)).toEqual({ outcome: 'stale' })
  })

  it('ticks every undecided file when an answer opens', async () => {
    const withFiles = run({
      files: [
        { id: 'f1', path: 'a.js', action: 'create', contents: 'x', size: 1, status: 'proposed' },
        { id: 'f2', path: 'b.js', action: 'create', contents: 'y', size: 1, status: 'applied' },
      ],
    })

    server({ onRun: () => stream([['result', { run: withFiles }]]) })

    const { result } = renderHook(() => useCopilot(ROOM))
    await ready(result)
    await act(async () => {
      await result.current.ask({ action: 'code.tests' })
    })

    // Only the one still awaiting a decision: a file already written is not
    // something to offer to write again.
    expect([...result.current.selected]).toEqual(['f1'])
  })

  it('sends exactly what was ticked, and nothing else', async () => {
    const withFiles = run({
      files: [
        { id: 'f1', path: 'a.js', action: 'create', contents: 'x', size: 1, status: 'proposed' },
        { id: 'f2', path: 'b.js', action: 'create', contents: 'y', size: 1, status: 'proposed' },
      ],
    })

    const fetchSpy = server({
      onRun: () => stream([['result', { run: withFiles }]]),
      apply: { run: withFiles, applied: 1, rejected: 1, failed: 0 },
    })

    const { result } = renderHook(() => useCopilot(ROOM))
    await ready(result)
    await act(async () => {
      await result.current.ask({ action: 'code.tests' })
    })

    act(() => result.current.toggle('f2'))
    await act(async () => {
      await result.current.applyFiles()
    })

    const applyCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/apply'))
    expect(JSON.parse(applyCall[1].body)).toEqual({ accept: ['f1'] })
  })

  /** "None of this" is a decision, and the server records it as one. */
  it('lets an empty decision through', async () => {
    const withFiles = run({
      files: [{ id: 'f1', path: 'a.js', action: 'create', contents: 'x', size: 1, status: 'proposed' }],
    })

    const fetchSpy = server({
      onRun: () => stream([['result', { run: withFiles }]]),
      apply: { run: withFiles, applied: 0, rejected: 1, failed: 0 },
    })

    const { result } = renderHook(() => useCopilot(ROOM))
    await ready(result)
    await act(async () => {
      await result.current.ask({ action: 'code.tests' })
    })

    act(() => result.current.setAll(false))
    await act(async () => {
      await result.current.applyFiles()
    })

    const applyCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/apply'))
    expect(JSON.parse(applyCall[1].body)).toEqual({ accept: [] })
  })
})
