import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as Y from 'yjs'
import { ReplayViewer } from './ReplayViewer.jsx'
import { setAuthToken } from '../../api/client.js'
import { covers, describeStep, fitTo, formatBytes, union } from '../../lib/replay.js'

/**
 * Watching a room being built.
 *
 * The states served here are real Yjs update streams, folded exactly the way
 * the server folds them, so the decoding in useReplay is under test rather
 * than mocked around. Only the Konva board is stubbed — jsdom has no canvas,
 * and stubbing the one component that paints is honest in a way that stubbing
 * the viewer would not be.
 */

vi.mock('./ReplayBoard.jsx', () => ({
  ReplayBoard: ({ shapes }) => (
    <div data-testid="board" data-count={shapes.length}>
      {shapes.map((shape) => (
        <span key={shape.id}>{shape.id}</span>
      ))}
    </div>
  ),
}))

const ROOM = 'MSTTPQuJ'
const ALICE = '65f0000000000000000000a1'
const BOB = '65f0000000000000000000b2'

/** The three edits every test below replays, and the update each produced. */
function record() {
  const doc = new Y.Doc()
  const updates = []
  doc.on('update', (update) => updates.push(update))

  doc.getText('code').insert(0, 'hello')
  doc.getArray('shapes').push([{ id: 's1', type: 'rect', x: 10, y: 10, width: 40, height: 30 }])
  doc.getText('code').insert(5, ' world')

  doc.destroy()
  return updates
}

const UPDATES = record()

/** What the server would answer for `/replay/:seq`: the fold up to that point. */
function stateAt(seq) {
  const doc = new Y.Doc()
  UPDATES.slice(0, seq).forEach((update) => Y.applyUpdate(doc, update))
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return state
}

const TIMELINE = [
  { seq: 1, actor: ALICE, size: 24, at: '2026-09-04T10:00:00.000Z' },
  { seq: 2, actor: BOB, size: 61, at: '2026-09-04T10:00:05.000Z' },
  { seq: 3, actor: null, size: 19, at: '2026-09-04T10:00:11.000Z' },
]

const PEOPLE = {
  owner: { id: ALICE, name: 'Ada', email: 'ada@example.com' },
  members: [{ id: BOB, name: 'Bo', email: 'bo@example.com', role: 'editor' }],
  blocked: [],
  pending: [],
  participants: [],
}

const ok = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) })

const refused = (status, code, message) => ({
  ok: false,
  status,
  json: () => Promise.resolve({ error: { code, message } }),
})

let calls

function mockServer({ timeline = TIMELINE, people = PEOPLE, timelineFails = null } = {}) {
  calls = []

  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const path = String(url)
    calls.push(path)

    if (path.includes('/people')) {
      return Promise.resolve(people ? ok(people) : refused(401, 'unauthorized', 'Sign in'))
    }

    const point = path.match(/\/replay\/(\d+)/)
    if (point) {
      const bytes = stateAt(Number(point[1]))
      // A fresh buffer: the view the test holds must not be what the code reads.
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
      })
    }

    if (path.includes('/replay')) {
      if (timelineFails) return Promise.resolve(timelineFails)
      const query = new URLSearchParams(path.split('?')[1] || '')
      const from = Number(query.get('from') || 0)
      const limit = Number(query.get('limit') || 500)
      return Promise.resolve(ok({ timeline: timeline.filter((e) => e.seq > from).slice(0, limit) }))
    }

    return Promise.resolve(ok({}))
  })
}

const open = (props = {}) => render(<ReplayViewer roomId={ROOM} onClose={() => {}} {...props} />)

const scrubber = () => screen.getByRole('slider', { name: 'Position in history' })

/** Drags the scrubber. A range input answers to its value, not to keystrokes. */
const dragTo = (position) => fireEvent.change(scrubber(), { target: { value: String(position) } })

const back = () => userEvent.click(screen.getByRole('button', { name: 'One change back' }))
const forward = () => userEvent.click(screen.getByRole('button', { name: 'One change forward' }))
const board = () => screen.getByTestId('board')
const stateRequests = () => calls.filter((path) => /\/replay\/\d+/.test(path))

/** Waits for the viewer to settle on a position and reports what it shows. */
async function settled(at, total) {
  await waitFor(() => expect(screen.getByText(at + ' / ' + total)).toBeInTheDocument())
}

beforeEach(() => {
  setAuthToken('token-1')
  mockServer()
})

describe('ReplayViewer', () => {
  it('opens on the present, not on an empty room', async () => {
    open()
    await settled(3, 3)

    // The last recorded state: both edits to the buffer, and the shape.
    expect(await screen.findByText('hello world')).toBeInTheDocument()
    expect(board()).toHaveAttribute('data-count', '1')
  })

  it('rebuilds the board and the buffer at an earlier point', async () => {
    open()
    await settled(3, 3)

    // Position 1: the first insert had happened, the shape had not.
    dragTo(1)

    await settled(1, 3)
    expect(await screen.findByText('hello')).toBeInTheDocument()
    expect(board()).toHaveAttribute('data-count', '0')
  })

  /**
   * Position zero is the document before anything was recorded. The server
   * would answer it correctly; there is simply nothing to ask about.
   */
  it('shows the empty document at position zero without asking the server', async () => {
    open()
    await settled(3, 3)

    dragTo(0)
    await settled(0, 3)

    expect(await screen.findByText(/Nothing had been typed yet/)).toBeInTheDocument()
    expect(board()).toHaveAttribute('data-count', '0')
    expect(calls.some((path) => path.includes('/replay/0'))).toBe(false)
  })

  it('reads a point it has already seen from memory', async () => {
    open()
    await settled(3, 3)

    await back()
    await settled(2, 3)
    await screen.findByText('hello')

    await forward()
    await settled(3, 3)
    await screen.findByText('hello world')

    await back()
    await settled(2, 3)

    const forSeqTwo = stateRequests().filter((path) => path.endsWith('/replay/2'))
    expect(forSeqTwo).toHaveLength(1)
  })

  it('names who made the change, and says when nobody was signed in', async () => {
    open()
    await settled(3, 3)

    // The third change had no actor: someone editing without an account.
    expect(await screen.findByText('A guest')).toBeInTheDocument()

    dragTo(2)
    expect(await screen.findByText('Bo')).toBeInTheDocument()

    dragTo(1)
    expect(await screen.findByText('Ada')).toBeInTheDocument()
  })

  /** Resolving names needs an account; a guest watching a public room does not. */
  it('still replays when the names cannot be read', async () => {
    mockServer({ people: null })
    open()
    await settled(3, 3)

    expect(await screen.findByText('hello world')).toBeInTheDocument()

    dragTo(2)
    expect(await screen.findByText('Someone')).toBeInTheDocument()
  })

  it('steps one change at a time, and stops at both ends', async () => {
    open()
    await settled(3, 3)

    expect(screen.getByRole('button', { name: 'One change forward' })).toBeDisabled()

    await back()
    await settled(2, 3)
    expect(screen.getByRole('button', { name: 'One change forward' })).toBeEnabled()

    await back()
    await back()
    await settled(0, 3)
    expect(screen.getByRole('button', { name: 'One change back' })).toBeDisabled()
  })

  /** Pressing play at the end is a request to watch it again, not a no-op. */
  it('plays from the beginning when it is already at the end', async () => {
    open()
    await settled(3, 3)

    await userEvent.click(screen.getByRole('button', { name: 'Play from the beginning' }))

    // It restarts at the top rather than sitting at the end doing nothing.
    expect(screen.getByText('0 / 3')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('3 / 3')).toBeInTheDocument(), { timeout: 8000 })

    // And it stops there rather than looping.
    expect(await screen.findByRole('button', { name: 'Play from the beginning' })).toBeInTheDocument()
  }, 15000)

  it('pages the timeline until the log runs out', async () => {
    const long = Array.from({ length: 502 }, (_, i) => ({
      seq: i + 1,
      actor: ALICE,
      size: 8,
      at: '2026-09-04T10:00:00.000Z',
    }))
    mockServer({ timeline: long })

    open()
    await settled(502, 502)

    const pages = calls.filter((path) => /\/replay\?/.test(path))
    expect(pages[0]).toContain('from=0')
    // The second page starts after the last seq the first one carried.
    expect(pages[1]).toContain('from=500')
  })

  it('says when the server keeps no update log', async () => {
    mockServer({
      timelineFails: refused(
        400,
        'replay_disabled',
        'Replay is disabled (PERSIST_UPDATE_LOG=false)'
      ),
    })
    open()

    expect(await screen.findByText(/not keeping an update log/)).toBeInTheDocument()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('reports a refusal rather than showing an empty history', async () => {
    mockServer({
      timelineFails: refused(403, 'room_forbidden', 'You do not have access to this room'),
    })
    open()

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('You do not have access to this room')).toBeInTheDocument()
  })

  it('says so when the room has recorded nothing yet', async () => {
    mockServer({ timeline: [] })
    open()

    expect(await screen.findByText(/Nothing has been recorded in this room yet/)).toBeInTheDocument()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('closes without touching the live room', async () => {
    const onClose = vi.fn()
    open({ onClose })
    await settled(3, 3)

    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('replay helpers', () => {
  it('fits a box inside a pane, centred', () => {
    const view = fitTo({ x: 0, y: 0, width: 200, height: 100 }, { width: 280, height: 180 })
    // 200 wide into 200 usable, 100 tall into 100 usable: exactly 1:1.
    expect(view.scale).toBe(1)
    expect(view.x).toBe(40)
    expect(view.y).toBe(40)
  })

  it('never blows a small drawing up past life size', () => {
    const view = fitTo({ x: 0, y: 0, width: 10, height: 10 }, { width: 1000, height: 1000 })
    expect(view.scale).toBe(1)
  })

  it('scales a drawing that is bigger than the pane down to fit', () => {
    const view = fitTo({ x: 0, y: 0, width: 2000, height: 100 }, { width: 280, height: 180 })
    expect(view.scale).toBeCloseTo(0.1)
  })

  it('answers a neutral camera when there is nothing to fit', () => {
    expect(fitTo(null, { width: 100, height: 100 })).toEqual({ scale: 1, x: 0, y: 0 })
    expect(fitTo({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    })
  })

  it('knows when the camera already covers what is on screen', () => {
    const outer = { x: 0, y: 0, width: 100, height: 100 }
    expect(covers(outer, { x: 10, y: 10, width: 10, height: 10 })).toBe(true)
    expect(covers(outer, { x: 90, y: 10, width: 30, height: 10 })).toBe(false)
    expect(covers(null, { x: 0, y: 0, width: 1, height: 1 })).toBe(false)
    expect(covers(outer, null)).toBe(true)
  })

  it('grows a box to hold both, and tolerates either being absent', () => {
    expect(union({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 10 })).toEqual(
      { x: 0, y: 0, width: 30, height: 15 }
    )
    expect(union(null, { x: 2, y: 2, width: 4, height: 4 })).toEqual({ x: 2, y: 2, width: 4, height: 4 })
    expect(union({ x: 1, y: 1, width: 2, height: 2 }, null)).toEqual({ x: 1, y: 1, width: 2, height: 2 })
    expect(union(null, null)).toBeNull()
  })

  it('reads update sizes the way a person does', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(undefined)).toBe('')
  })

  it('describes a position, including the one before the log begins', () => {
    const names = new Map([[ALICE, 'Ada']])
    expect(describeStep(0, TIMELINE, names).title).toBe('Before the first change')
    expect(describeStep(1, TIMELINE, names).title).toBe('Ada')
    expect(describeStep(2, TIMELINE, names).title).toBe('Someone')
    expect(describeStep(3, TIMELINE, names).title).toBe('A guest')
    expect(describeStep(1, TIMELINE, names).detail).toContain('24 B')
  })
})
