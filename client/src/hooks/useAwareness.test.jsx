import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAwareness, useCursorBroadcast } from './useAwareness.js'

/**
 * The two costs of presence: how many messages leave, and how often the room
 * re-renders because of the ones that arrive.
 */

describe('broadcasting a pointer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function recorder() {
    const sent = []
    return {
      sent,
      setAwarenessField(key, value) {
        sent.push({ key, value })
      },
    }
  }

  const cursors = (provider) => provider.sent.filter((entry) => entry.key === 'cursor')

  /**
   * A pointer can fire a thousand moves a second. Before this change the board
   * sent one every 40ms, 25 a second; it now sends about 15, and the receiving
   * side eases between them.
   */
  it('sends about fifteen positions a second however fast the pointer moves', () => {
    const provider = recorder()
    const { result } = renderHook(() => useCursorBroadcast(provider))

    act(() => {
      for (let i = 0; i < 1000; i += 1) {
        result.current.publish({ x: i, y: i })
        vi.advanceTimersByTime(1)
      }
      vi.advanceTimersByTime(200)
    })

    const sends = cursors(provider).length
    expect(sends).toBeGreaterThanOrEqual(14)
    expect(sends).toBeLessThanOrEqual(18)
    expect(sends).toBeLessThan(1000 / 40)

    // Throttling must not lose where the pointer ended up.
    expect(cursors(provider).at(-1).value).toEqual({ x: 999, y: 999 })
  })

  it('sends a resting pointer once, not on every jitter', () => {
    const provider = recorder()
    const { result } = renderHook(() => useCursorBroadcast(provider))

    act(() => {
      for (let i = 0; i < 300; i += 1) {
        // Sub-unit jitter from a hand resting on a trackpad.
        result.current.publish({ x: 10 + (i % 3) * 0.1, y: 20.4 })
        vi.advanceTimersByTime(5)
      }
    })

    expect(cursors(provider)).toHaveLength(1)
    expect(cursors(provider)[0].value).toEqual({ x: 10, y: 20 })
  })

  it('withdraws the pointer once when sharing is turned off, and sends nothing after', () => {
    const provider = recorder()
    const { result, rerender } = renderHook(
      ({ enabled }) => useCursorBroadcast(provider, { enabled }),
      { initialProps: { enabled: true } }
    )

    act(() => result.current.publish({ x: 1, y: 1 }))
    rerender({ enabled: false })

    act(() => {
      for (let i = 0; i < 100; i += 1) {
        result.current.publish({ x: i, y: i })
        vi.advanceTimersByTime(10)
      }
    })

    const values = cursors(provider).map((entry) => entry.value)
    expect(values).toEqual([{ x: 1, y: 1 }, null])
  })
})

describe('reading everybody else', () => {
  const cleanups = []
  afterEach(() => {
    while (cleanups.length) cleanups.pop()()
  })

  function linked() {
    const mine = new Awareness(new Y.Doc())
    const theirs = new Awareness(new Y.Doc())
    cleanups.push(() => mine.destroy(), () => theirs.destroy())

    const onUpdate = ({ added, updated, removed }) => {
      applyAwarenessUpdate(mine, encodeAwarenessUpdate(theirs, added.concat(updated, removed)), 'relay')
    }
    theirs.on('update', onUpdate)
    cleanups.push(() => theirs.off('update', onUpdate))

    mine.setLocalStateField('user', { id: 'me', name: 'Me', color: '#f97316' })
    theirs.setLocalStateField('user', { id: 'them', name: 'Ayush', color: '#22d3ee' })
    return { mine, theirs }
  }

  /**
   * The header avatars and the people list render from this. At pointer rate
   * that is every avatar redrawn for every twitch of somebody's mouse.
   */
  it('re-renders when somebody changes what they are doing, not when their pointer moves', () => {
    const { mine, theirs } = linked()

    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useAwareness({ awareness: mine })
    })

    const settled = renders

    act(() => {
      for (let i = 0; i < 50; i += 1) theirs.setLocalStateField('cursor', { x: i, y: i })
    })
    expect(renders).toBe(settled)
    // Still current, for whatever reads it live.
    expect(result.current.peers[0].cursor).toEqual({ x: 49, y: 49 })

    act(() => {
      theirs.setLocalStateField('presence', { v: 1, activity: 'editing', share: true })
    })
    expect(renders).toBe(settled + 1)
    expect(result.current.peers[0].presence.activity).toBe('editing')
  })
})
