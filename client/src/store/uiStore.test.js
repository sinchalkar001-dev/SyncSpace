import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_SCALE, MIN_SCALE, useUIStore } from './uiStore.js'

const reset = () =>
  useUIStore.setState({ splitRatio: 0.5, viewport: { scale: 1, x: 0, y: 0 }, tool: 'pen' })

beforeEach(reset)

describe('ui store', () => {
  it('clamps the split ratio so a pane cannot collapse', () => {
    useUIStore.getState().setSplitRatio(0.01)
    expect(useUIStore.getState().splitRatio).toBe(0.15)

    useUIStore.getState().setSplitRatio(0.99)
    expect(useUIStore.getState().splitRatio).toBe(0.85)
  })

  it('keeps zoom inside its bounds', () => {
    for (let i = 0; i < 40; i += 1) useUIStore.getState().zoomBy(2)
    expect(useUIStore.getState().viewport.scale).toBe(MAX_SCALE)

    for (let i = 0; i < 60; i += 1) useUIStore.getState().zoomBy(0.5)
    expect(useUIStore.getState().viewport.scale).toBe(MIN_SCALE)
  })

  it('restores the viewport on reset', () => {
    useUIStore.getState().setViewport({ scale: 2.5, x: 120, y: -40 })
    useUIStore.getState().resetViewport()
    expect(useUIStore.getState().viewport).toEqual({ scale: 1, x: 0, y: 0 })
  })

  /**
   * Panning and zooming are both defined relative to where the view already
   * is, so both call sites on the board pass an updater rather than a value.
   * Storing the updater itself left the board with an undefined scale and
   * origin from the first wheel or drag onwards.
   */
  it('takes an updater as well as a value', () => {
    useUIStore.getState().setViewport({ scale: 2, x: 10, y: 20 })
    useUIStore.getState().setViewport((current) => ({ ...current, x: 300, y: 400 }))

    expect(useUIStore.getState().viewport).toEqual({ scale: 2, x: 300, y: 400 })
  })

  it('never stores a function where the viewport should be', () => {
    useUIStore.getState().setViewport((current) => ({ ...current, x: 55 }))
    const { viewport } = useUIStore.getState()

    expect(typeof viewport).toBe('object')
    expect(Number.isFinite(viewport.scale)).toBe(true)
    expect(Number.isFinite(viewport.x)).toBe(true)
    expect(Number.isFinite(viewport.y)).toBe(true)
  })

  it('switches the active tool', () => {
    useUIStore.getState().setTool('eraser')
    expect(useUIStore.getState().tool).toBe('eraser')
  })
})
