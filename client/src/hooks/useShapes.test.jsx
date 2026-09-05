import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import * as Y from 'yjs'
import { pushShape, updateShape } from '../lib/collab.js'
import { useShapes } from './useShapes.js'

/**
 * The bridge between the shared document and the canvas.
 *
 * It used to watch the shapes array with `observe`, which fires only when the
 * array gains or loses an entry. Every change to an existing shape lives in a
 * Y.Map inside that array, so none of them arrived: locking a shape did not
 * update the toolbar, and a shape another person moved stayed where it was for
 * everyone but them. The tests below are mostly about that class of change.
 */

const board = () => {
  const doc = new Y.Doc()
  return { doc, shapes: doc.getArray('shapes') }
}

const rect = (id, extra = {}) => ({
  id,
  type: 'rect',
  x: 10,
  y: 10,
  width: 40,
  height: 30,
  stroke: '#fff',
  strokeWidth: 2,
  ...extra,
})

describe('useShapes', () => {
  it('starts with whatever the document already holds', () => {
    const { shapes } = board()
    pushShape(shapes, rect('a'))

    const { result } = renderHook(() => useShapes(shapes))
    expect(result.current.map((s) => s.id)).toEqual(['a'])
  })

  it('sees a shape added', () => {
    const { shapes } = board()
    const { result } = renderHook(() => useShapes(shapes))

    act(() => {
      pushShape(shapes, rect('a'))
    })
    expect(result.current.map((s) => s.id)).toEqual(['a'])
  })

  /** The one that was broken: a change *inside* a shape, not to the array. */
  it('sees a shape move', () => {
    const { shapes } = board()
    pushShape(shapes, rect('a'))
    const { result } = renderHook(() => useShapes(shapes))
    expect(result.current[0].x).toBe(10)

    act(() => {
      updateShape(shapes, 'a', { x: 300, y: 250 })
    })

    expect(result.current[0].x).toBe(300)
    expect(result.current[0].y).toBe(250)
  })

  it('sees a shape locked and unlocked', () => {
    const { shapes } = board()
    pushShape(shapes, rect('a'))
    const { result } = renderHook(() => useShapes(shapes))
    expect(result.current[0].locked).toBeUndefined()

    act(() => {
      updateShape(shapes, 'a', { locked: true })
    })
    expect(result.current[0].locked).toBe(true)

    act(() => {
      updateShape(shapes, 'a', { locked: false })
    })
    expect(result.current[0].locked).toBe(false)
  })

  it('sees a restyle', () => {
    const { shapes } = board()
    pushShape(shapes, rect('a'))
    const { result } = renderHook(() => useShapes(shapes))

    act(() => {
      updateShape(shapes, 'a', { stroke: '#f2a03f', strokeWidth: 6 })
    })

    expect(result.current[0].stroke).toBe('#f2a03f')
    expect(result.current[0].strokeWidth).toBe(6)
  })

  /**
   * The change that arrives over the wire rather than from this browser, which
   * is the case that made the original bug invisible: the person dragging sees
   * Konva move the node whether or not React ever hears about it.
   */
  it('sees a change made by someone else in the room', () => {
    const mine = new Y.Doc()
    const theirs = new Y.Doc()
    const mineShapes = mine.getArray('shapes')
    const theirShapes = theirs.getArray('shapes')

    pushShape(mineShapes, rect('a'))
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine))

    const { result } = renderHook(() => useShapes(mineShapes))
    expect(result.current[0].x).toBe(10)

    // They move it, and their update reaches this document.
    updateShape(theirShapes, 'a', { x: 640 })
    act(() => {
      Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs))
    })

    expect(result.current[0].x).toBe(640)
  })

  it('sees a shape removed', () => {
    const { shapes } = board()
    pushShape(shapes, rect('a'))
    pushShape(shapes, rect('b'))
    const { result } = renderHook(() => useShapes(shapes))

    act(() => {
      shapes.delete(0, 1)
    })
    expect(result.current.map((s) => s.id)).toEqual(['b'])
  })

  it('empties when there is no document to watch', () => {
    const { result } = renderHook(() => useShapes(null))
    expect(result.current).toEqual([])
  })

  it('stops listening when it goes away', () => {
    const { shapes } = board()
    const { unmount } = renderHook(() => useShapes(shapes))

    unmount()
    // Would throw "Cannot read properties of null" if the observer were still
    // attached and tried to set state on an unmounted hook.
    expect(() => pushShape(shapes, rect('a'))).not.toThrow()
  })
})
