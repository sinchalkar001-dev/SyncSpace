import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useComments } from './useComments.js'
import { setAuthToken } from '../api/client.js'

/**
 * A room's comments, as the room sees them: shown the moment they are written,
 * taken back if the server refuses, and never rolled back over somebody else's
 * newer change.
 */

const ROOM = 'MSTTPQuJ'
const ME = { id: '65f0000000000000000000a1', name: 'Ada' }
const BO = '65f0000000000000000000b2'

const at = (minute) => new Date(Date.UTC(2026, 8, 11, 10, minute)).toISOString()

const message = (id, author, body, minute, extra = {}) => ({
  id,
  author,
  authorName: author === ME.id ? 'Ada' : 'Bo',
  body,
  mentions: [],
  createdAt: at(minute),
  editedAt: null,
  deleted: false,
  ...extra,
})

const thread = (id, version, extra = {}) => ({
  id,
  roomId: ROOM,
  anchor: { kind: 'region', x: 10, y: 20, width: 0, height: 0 },
  status: 'open',
  version,
  createdSeq: 0,
  events: [],
  updatedAt: at(version),
  messages: [message(id + '-m1', BO, 'look here', 1)],
  ...extra,
})

const ok = (body, status = 200) => ({ ok: true, status, json: () => Promise.resolve(body) })
const refused = (status, text) => ({
  ok: false,
  status,
  json: () => Promise.resolve({ error: { code: 'refused', message: text } }),
})

/** A promise the test settles by hand, for a request still in flight. */
function pending() {
  let settle
  const promise = new Promise((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

let calls

function mockServer(answer) {
  calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    const method = init.method || 'GET'
    const path = String(url)
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined })

    if (path.includes('/people')) {
      return Promise.resolve(
        ok({ owner: { id: ME.id, name: 'Ada' }, members: [{ id: BO, name: 'Bo' }], participants: [] })
      )
    }
    return Promise.resolve(answer(method, path))
  })
}

const listing = (threads = [thread('t1', 1)], seenAt = at(0)) => ok({ threads, seenAt })

async function mount(options = {}) {
  const hook = renderHook(() => useComments(ROOM, { user: ME, ...options }))
  await waitFor(() => expect(hook.result.current.state).toBe('ready'))
  return hook
}

beforeEach(() => {
  setAuthToken('token-1')
})

describe('useComments', () => {
  it('loads the threads and counts what is new since the last look', async () => {
    mockServer(() => listing())
    const { result } = await mount()

    expect(result.current.threads.map((entry) => entry.id)).toEqual(['t1'])
    expect(result.current.unread).toEqual({ count: 1, mentions: 0 })
  })

  /** The picker offers the room's people, and never yourself. */
  it('offers the people in the room for mentions', async () => {
    mockServer(() => listing())
    const { result } = await mount()

    await waitFor(() => expect(result.current.people).toEqual([{ id: BO, name: 'Bo' }]))

    // Names for highlighting do include you: a mention of you matters most.
    expect(result.current.names.get(BO)).toBe('Bo')
    expect(result.current.names.get(ME.id)).toBe('Ada')
  })

  it('shows a new comment at once, then swaps in the saved one', async () => {
    const reply = pending()
    mockServer((method) => (method === 'POST' ? reply.promise : listing([])))
    const { result } = await mount()

    let created
    act(() => {
      created = result.current.create({ anchor: { kind: 'region', x: 1, y: 2 }, text: 'hi' })
    })

    expect(result.current.threads).toHaveLength(1)
    expect(result.current.threads[0]).toMatchObject({
      pending: true,
      messages: [{ body: 'hi', authorName: 'Ada', pending: true }],
    })

    await act(async () => {
      reply.settle(ok({ thread: thread('t9', 1, { messages: [message('m9', ME.id, 'hi', 2)] }) }, 201))
      await created
    })

    expect(result.current.threads.map((entry) => entry.id)).toEqual(['t9'])
    expect(result.current.threads[0].pending).toBeUndefined()
    expect(calls.find((call) => call.method === 'POST').body).toEqual({
      anchor: { kind: 'region', x: 1, y: 2 },
      text: 'hi',
      mentions: [],
      ref: expect.stringMatching(/^pending-thread-/),
    })
  })

  /**
   * The announcement of a new thread usually reaches its author before the
   * response does. It replaces the placeholder then and there — the thread
   * must never be on screen twice.
   */
  it('swaps the placeholder for the saved thread when the announcement arrives first', async () => {
    const reply = pending()
    mockServer((method) => (method === 'POST' ? reply.promise : listing([])))
    const { result } = await mount()

    let created
    act(() => {
      created = result.current.create({ anchor: { kind: 'region', x: 1, y: 2 }, text: 'hi' })
    })
    const ref = calls.find((call) => call.method === 'POST').body.ref
    const saved = thread('t9', 1, { messages: [message('m9', ME.id, 'hi', 2)] })

    act(() => result.current.receive({ roomId: ROOM, thread: saved, ref }))
    expect(result.current.threads.map((entry) => entry.id)).toEqual(['t9'])

    await act(async () => {
      reply.settle(ok({ thread: saved }, 201))
      await created
    })
    expect(result.current.threads.map((entry) => entry.id)).toEqual(['t9'])
  })

  it('leaves somebody else’s placeholder alone', async () => {
    mockServer(() => listing())
    const { result } = await mount()

    act(() => result.current.receive({ roomId: ROOM, thread: thread('t2', 1), ref: 'pending-thread-x-1' }))
    expect(result.current.threads.map((entry) => entry.id).sort()).toEqual(['t1', 't2'])
  })

  it('takes a refused comment back out, and says why', async () => {
    const onError = vi.fn()
    mockServer((method) =>
      method === 'POST' ? refused(403, 'Your role in this room cannot comment') : listing([])
    )
    const { result } = await mount({ onError })

    await act(async () => {
      await result.current.create({ anchor: { kind: 'region', x: 1, y: 2 }, text: 'hi' })
    })

    expect(result.current.threads).toHaveLength(0)
    expect(onError).toHaveBeenCalledWith('Your role in this room cannot comment')
  })

  /**
   * The rollback that matters. Another person's reply lands over the socket
   * while this person's own reply is still in flight; when that one is then
   * refused, undoing it must not undo theirs too.
   */
  it('undoes a refused reply without erasing a newer one that arrived meanwhile', async () => {
    const answer = pending()
    mockServer((method, path) => (path.endsWith('/replies') ? answer.promise : listing()))
    const { result } = await mount({ onError: () => {} })

    let replying
    act(() => {
      replying = result.current.reply('t1', { text: 'mine' })
    })
    expect(result.current.threads[0].messages.map((entry) => entry.body)).toEqual(['look here', 'mine'])

    const theirs = thread('t1', 2, {
      messages: [message('t1-m1', BO, 'look here', 1), message('m2', BO, 'and here', 3)],
    })
    act(() => result.current.receive({ roomId: ROOM, thread: theirs }))

    await act(async () => {
      answer.settle(refused(429, 'Too many comments, try again shortly'))
      await replying
    })

    expect(result.current.threads[0].version).toBe(2)
    expect(result.current.threads[0].messages.map((entry) => entry.body)).toEqual(['look here', 'and here'])
  })

  it('resolves at once, and reopens again if the server says no', async () => {
    const answer = pending()
    mockServer((method) => (method === 'PATCH' ? answer.promise : listing()))
    const { result } = await mount({ onError: () => {} })

    let resolving
    act(() => {
      resolving = result.current.setResolved('t1', true)
    })
    expect(result.current.all[0].status).toBe('resolved')

    await act(async () => {
      answer.settle(refused(403, 'nope'))
      await resolving
    })
    expect(result.current.all[0].status).toBe('open')
  })

  it('edits and deletes in place, keeping the server copy', async () => {
    mockServer((method) => {
      if (method === 'PATCH') {
        return ok({ thread: thread('t1', 2, { messages: [message('t1-m1', BO, 'fixed', 1, { editedAt: at(4) })] }) })
      }
      if (method === 'DELETE') {
        return ok({
          thread: thread('t1', 3, {
            messages: [message('t1-m1', BO, '', 1, { deleted: true }), message('m2', ME.id, 'still here', 2)],
          }),
        })
      }
      return listing()
    })
    const { result } = await mount()

    await act(async () => {
      await result.current.edit('t1', 't1-m1', { text: 'fixed' })
    })
    expect(result.current.threads[0].messages[0]).toMatchObject({ body: 'fixed', editedAt: at(4) })

    await act(async () => {
      await result.current.remove('t1', 't1-m1')
    })
    expect(result.current.threads[0].messages[0]).toMatchObject({ deleted: true, body: '' })
    expect(result.current.threads[0].version).toBe(3)
  })

  /** A thread whose every message has been deleted is gone as far as the room is concerned. */
  it('drops a thread with nothing left in it from the list', async () => {
    mockServer(() =>
      listing([thread('t1', 1, { messages: [message('m1', BO, '', 1, { deleted: true })] }), thread('t2', 1)])
    )
    const { result } = await mount()

    expect(result.current.threads.map((entry) => entry.id)).toEqual(['t2'])
    expect(result.current.all).toHaveLength(2)
  })

  it('ignores a stale copy, and announcements for another room', async () => {
    mockServer(() => listing())
    const { result } = await mount()

    act(() => result.current.receive({ roomId: ROOM, thread: thread('t1', 0, { status: 'resolved' }) }))
    expect(result.current.threads[0].status).toBe('open')

    act(() => result.current.receive({ roomId: 'elsewhere', thread: thread('t7', 5) }))
    expect(result.current.threads.map((entry) => entry.id)).toEqual(['t1'])

    act(() => result.current.receive({ roomId: ROOM, thread: thread('t1', 2, { status: 'resolved' }) }))
    expect(result.current.threads[0].status).toBe('resolved')
  })

  it('clears the count when read, and tells the server', async () => {
    mockServer((method) => (method === 'POST' ? ok({ seenAt: at(9) }) : listing()))
    const { result } = await mount()
    expect(result.current.unread.count).toBe(1)

    act(() => result.current.markSeen())

    expect(result.current.unread.count).toBe(0)
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/comments/seen'))).toBe(true)
    )
  })

  it('says so when the comments cannot be read, and can try again', async () => {
    let fail = true
    mockServer(() => (fail ? refused(403, 'You do not have access to this room') : listing()))
    const { result } = renderHook(() => useComments(ROOM, { user: ME }))

    await waitFor(() => expect(result.current.state).toBe('error'))
    expect(result.current.error).toBe('You do not have access to this room')

    fail = false
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.state).toBe('ready')
    expect(result.current.threads).toHaveLength(1)
  })
})
