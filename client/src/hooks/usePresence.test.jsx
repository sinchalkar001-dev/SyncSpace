import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePresence } from './usePresence.js'

/**
 * Presence against real awareness, between two real clients.
 *
 * Two y-protocols `Awareness` instances relayed into each other behave exactly
 * as two browsers on one Hocuspocus document do — the server forwards
 * awareness updates and nothing else — without a network in the way. Every
 * message a client sends is recorded, so these tests can hold the traffic
 * claims to numbers rather than to intentions.
 */

const cleanups = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()()
})

const wait = (ms) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

function client(name) {
  const awareness = new Awareness(new Y.Doc())
  awareness.setLocalStateField('user', { id: name, name, color: '#22d3ee' })

  const sent = []
  const provider = {
    awareness,
    sent,
    setAwarenessField(key, value) {
      sent.push({ key, value })
      awareness.setLocalStateField(key, value)
    },
  }

  cleanups.push(() => awareness.destroy())
  return provider
}

/** Forwards awareness between two clients the way the collab server does. */
function connect(a, b) {
  const relay = (from, to) => {
    const onUpdate = ({ added, updated, removed }) => {
      const changed = added.concat(updated, removed)
      applyAwarenessUpdate(to.awareness, encodeAwarenessUpdate(from.awareness, changed), 'relay')
    }
    from.awareness.on('update', onUpdate)
    cleanups.push(() => from.awareness.off('update', onUpdate))
  }

  relay(a, b)
  relay(b, a)

  // What a fresh connection does first: each side learns the other's state.
  applyAwarenessUpdate(b.awareness, encodeAwarenessUpdate(a.awareness, [a.awareness.clientID]), 'relay')
  applyAwarenessUpdate(a.awareness, encodeAwarenessUpdate(b.awareness, [b.awareness.clientID]), 'relay')
}

const sentOf = (provider, key) => provider.sent.filter((entry) => entry.key === key)
const presenceOf = (provider) => provider.awareness.getLocalState().presence

describe('what goes out', () => {
  it('sends a line once, however many times the caret reports it', async () => {
    const a = client('Jishu')
    const { result } = renderHook(() => usePresence({ provider: a, language: 'java' }))
    await wait(20)

    const before = sentOf(a, 'presence').length

    act(() => {
      for (let i = 0; i < 50; i += 1) result.current.reportCode({ line: 42 })
    })
    await wait(350)
    act(() => {
      for (let i = 0; i < 50; i += 1) result.current.reportCode({ line: 42 })
    })
    await wait(350)

    // A hundred reports, one message: the line changed once.
    expect(sentOf(a, 'presence').length - before).toBe(1)
    expect(presenceOf(a)).toMatchObject({
      surface: 'code',
      file: 'Main.java',
      line: 42,
      activity: 'reading',
    })
  })

  it('calls a keystroke from somebody who may edit, editing', async () => {
    const a = client('Jishu')
    const { result } = renderHook(() => usePresence({ provider: a, language: 'java' }))

    act(() => result.current.reportCode({ line: 3, typed: true }))
    await wait(20)

    expect(presenceOf(a).activity).toBe('editing')
  })

  it('reports a viewer who types as viewing, because nothing they type lands', async () => {
    const a = client('Viewer')
    const { result } = renderHook(() =>
      usePresence({ provider: a, language: 'python', canEditCode: false })
    )

    act(() => result.current.reportCode({ line: 3, typed: true }))
    await wait(20)

    expect(presenceOf(a).activity).toBe('reading')
  })

  it('sends no location at all while sharing is off', async () => {
    const a = client('Private')
    const { result } = renderHook(() =>
      usePresence({ provider: a, language: 'java', sharing: false })
    )

    act(() => result.current.reportCode({ line: 9, typed: true }))
    act(() => result.current.reportBoard({ selected: ['s1', 's2'], engaged: true }))
    await wait(300)

    const everything = sentOf(a, 'presence').map((entry) => entry.value)
    expect(everything.every((value) => value.line === null && value.selected === null)).toBe(true)
    expect(presenceOf(a)).toMatchObject({ share: false, surface: null, file: null })
  })

  /**
   * The largest saving, and the one easiest to break without noticing: a
   * viewport changes on every pan and zoom, and almost nobody is following
   * anybody.
   */
  it('sends no viewport while nobody is following', async () => {
    const a = client('Alone')
    const { result } = renderHook(() => usePresence({ provider: a, language: 'java' }))

    act(() => {
      for (let i = 0; i < 100; i += 1) result.current.reportView({ cx: i, cy: i, scale: 1 })
    })
    await wait(300)

    expect(sentOf(a, 'view')).toHaveLength(0)
  })
})

describe('following', () => {
  function pair({ leaderProps = {}, followerProps = {} } = {}) {
    const a = client('Leader')
    const b = client('Follower')
    connect(a, b)

    const leader = renderHook((props) => usePresence({ provider: a, language: 'java', ...props }), {
      initialProps: leaderProps,
    })
    const follower = renderHook(
      (props) => usePresence({ provider: b, language: 'java', ...props }),
      { initialProps: followerProps }
    )

    return { a, b, leader, follower }
  }

  it('starts the leader sending its view, and moves the follower with it', async () => {
    const { a, leader, follower } = pair()
    await wait(20)

    act(() => leader.result.current.reportView({ cx: 400, cy: 300, scale: 1.5 }))
    expect(sentOf(a, 'view')).toHaveLength(0)

    const moves = []
    follower.result.current.navigator.on('board', (payload) => moves.push(payload))

    let followed
    act(() => {
      followed = follower.result.current.follow(a.awareness.clientID)
    })
    await wait(200)

    expect(followed).toBe(true)
    expect(follower.result.current.following).toBe(a.awareness.clientID)
    expect(leader.result.current.followers.map((entry) => entry.name)).toEqual(['Follower'])
    expect(moves.at(-1)).toEqual({ view: { cx: 400, cy: 300, scale: 1.5 } })

    act(() => leader.result.current.reportView({ cx: 900, cy: 300, scale: 1.5 }))
    await wait(200)
    expect(moves.at(-1)).toEqual({ view: { cx: 900, cy: 300, scale: 1.5 } })

    // Letting go withdraws the viewport, so the leader stops paying for it.
    act(() => follower.result.current.unfollow())
    await wait(200)
    expect(a.awareness.getLocalState().view).toBeNull()
    expect(leader.result.current.followers).toEqual([])
  })

  it('scrolls the follower to the line the leader moves to', async () => {
    const { a, leader, follower } = pair()
    await wait(20)

    const lines = []
    follower.result.current.navigator.on('code', (payload) => lines.push(payload.line))

    act(() => {
      follower.result.current.follow(a.awareness.clientID)
    })
    act(() => leader.result.current.reportCode({ line: 12 }))
    await wait(300)
    act(() => leader.result.current.reportCode({ line: 30 }))
    await wait(300)

    expect(lines).toEqual([12, 30])
  })

  it('lets go, and says why, when the leader stops sharing', async () => {
    const ended = vi.fn()
    const { a, leader, follower } = pair({ followerProps: { onFollowEnded: ended } })
    await wait(20)

    act(() => {
      follower.result.current.follow(a.awareness.clientID)
    })
    await wait(50)

    leader.rerender({ sharing: false })
    await wait(100)

    expect(follower.result.current.following).toBeNull()
    expect(ended).toHaveBeenCalledWith('private', 'Leader')
  })

  it('refuses to follow somebody who is not sharing, or yourself', async () => {
    const { a, b, follower } = pair({ leaderProps: { sharing: false } })
    await wait(20)

    let result
    act(() => {
      result = [
        follower.result.current.follow(a.awareness.clientID),
        follower.result.current.follow(b.awareness.clientID),
      ]
    })

    expect(result).toEqual([false, false])
    expect(follower.result.current.following).toBeNull()
  })
})

describe('focusing', () => {
  it('jumps once to the line somebody is on, without following them', async () => {
    const a = client('Leader')
    const b = client('Finder')
    connect(a, b)

    const leader = renderHook(() => usePresence({ provider: a, language: 'java' }))
    const finder = renderHook(() => usePresence({ provider: b, language: 'java' }))

    act(() => leader.result.current.reportCode({ line: 42 }))
    await wait(50)

    const surfaces = []
    const lines = []
    finder.result.current.navigator.on('surface', (surface) => surfaces.push(surface))
    finder.result.current.navigator.on('code', (payload) => lines.push(payload.line))

    act(() => {
      finder.result.current.focus(a.awareness.clientID)
    })

    expect(surfaces).toEqual(['code'])
    expect(lines).toEqual([42])
    expect(finder.result.current.following).toBeNull()
  })
})
