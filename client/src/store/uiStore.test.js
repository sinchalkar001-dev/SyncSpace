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

  it('switches the active tool', () => {
    useUIStore.getState().setTool('eraser')
    expect(useUIStore.getState().tool).toBe('eraser')
  })
})
