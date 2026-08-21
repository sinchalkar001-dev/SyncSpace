import { describe, expect, it } from 'vitest'
import { isShapeHit, shapesHitBy } from './hitTest.js'

const rect = { id: 'r1', type: 'rect', x: 100, y: 100, width: 200, height: 40, strokeWidth: 3 }
const stroke = {
  id: 'l1',
  type: 'line',
  x: 0,
  y: 0,
  points: [100, 300, 200, 300, 300, 300],
  strokeWidth: 3,
}
const segment = { id: 's1', type: 'segment', x: 0, y: 0, points: [0, 0, 100, 100], strokeWidth: 3 }
const ellipse = { id: 'e1', type: 'ellipse', x: 500, y: 500, radiusX: 60, radiusY: 30, strokeWidth: 3 }
const diamond = { id: 'd1', type: 'diamond', x: 700, y: 100, width: 100, height: 100, strokeWidth: 3 }

describe('rectangles', () => {
  it('is hit in its empty middle, not just on the outline', () => {
    // The exact complaint: a stroked rectangle with no fill, clicked inside.
    expect(isShapeHit(rect, 200, 120, 14)).toBe(true)
  })

  it('is hit on its outline', () => {
    expect(isShapeHit(rect, 100, 100, 14)).toBe(true)
  })

  it('is hit just outside, within the eraser reach', () => {
    expect(isShapeHit(rect, 92, 120, 14)).toBe(true)
  })

  it('is not hit well clear of it', () => {
    expect(isShapeHit(rect, 40, 120, 14)).toBe(false)
    expect(isShapeHit(rect, 200, 220, 14)).toBe(false)
  })
})

describe('freehand strokes and straight runs', () => {
  it('is hit along the stroke', () => {
    expect(isShapeHit(stroke, 250, 300, 14)).toBe(true)
  })

  it('is hit a few pixels beside it, which is how people aim', () => {
    expect(isShapeHit(stroke, 250, 308, 14)).toBe(true)
  })

  it('is not hit far from it', () => {
    expect(isShapeHit(stroke, 250, 380, 14)).toBe(false)
  })

  it('is not hit past the end of the run', () => {
    expect(isShapeHit(stroke, 400, 300, 14)).toBe(false)
  })

  it('handles a diagonal segment', () => {
    expect(isShapeHit(segment, 50, 50, 14)).toBe(true)
    expect(isShapeHit(segment, 50, 90, 14)).toBe(false)
  })
})

describe('ellipses and diamonds', () => {
  it('hits inside an ellipse and misses outside it', () => {
    expect(isShapeHit(ellipse, 500, 500, 14)).toBe(true)
    expect(isShapeHit(ellipse, 545, 500, 14)).toBe(true)
    expect(isShapeHit(ellipse, 620, 500, 14)).toBe(false)
  })

  it('hits the middle of a diamond', () => {
    expect(isShapeHit(diamond, 750, 150, 14)).toBe(true)
  })

  it('misses a diamond corner region that looks inside its box but is not', () => {
    // Top-left of the bounding box is outside the rhombus, and far enough
    // from both edges to be a clean miss.
    expect(isShapeHit(diamond, 705, 105, 4)).toBe(false)
  })
})

describe('collecting hits', () => {
  const all = [rect, stroke, ellipse, diamond]

  it('returns every shape the circle touches, not just the top one', () => {
    const overlapping = [
      { id: 'a', type: 'rect', x: 0, y: 0, width: 100, height: 100, strokeWidth: 2 },
      { id: 'b', type: 'rect', x: 50, y: 50, width: 100, height: 100, strokeWidth: 2 },
    ]
    expect(shapesHitBy(overlapping, 75, 75, 10).sort()).toEqual(['a', 'b'])
  })

  it('returns nothing on empty canvas space', () => {
    expect(shapesHitBy(all, 5000, 5000, 14)).toEqual([])
  })

  it('ignores entries without an id', () => {
    expect(shapesHitBy([{ type: 'rect', x: 0, y: 0, width: 50, height: 50 }], 25, 25, 14)).toEqual([])
  })

  it('grows its reach with the radius, for zoomed-out boards', () => {
    expect(shapesHitBy(all, 250, 340, 5)).toEqual([])
    expect(shapesHitBy(all, 250, 340, 60)).toContain('l1')
  })
})
