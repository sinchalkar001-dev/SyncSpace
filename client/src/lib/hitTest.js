/**
 * Geometric hit testing for the whiteboard.
 *
 * The eraser used to ask Konva which node sat under a pixel, via its hit
 * canvas. That works, but it depends on rendering: one node per sample point,
 * the topmost only, and correctness tied to canvas pixel ratios and stage
 * transforms. Testing the shape data directly is deterministic, catches every
 * shape a stroke crosses rather than the top one, and can be proven in plain
 * unit tests with no browser involved.
 *
 * Everything here works in WORLD coordinates — the same space the shapes are
 * stored in — so zoom and pan are somebody else's problem.
 */

/** Shortest distance from a point to the segment ab. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy

  if (lengthSq === 0) return Math.hypot(px - ax, py - ay)

  // Projection of the point onto the segment, clamped to its ends.
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))

  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Shortest distance from a point to a flat [x0,y0,x1,y1,...] polyline. */
function distanceToPolyline(px, py, points, offsetX, offsetY, closed) {
  if (!points || points.length < 4) {
    if (points && points.length === 2) {
      return Math.hypot(px - (points[0] + offsetX), py - (points[1] + offsetY))
    }
    return Infinity
  }

  let best = Infinity
  for (let i = 0; i + 3 < points.length; i += 2) {
    best = Math.min(
      best,
      distanceToSegment(
        px,
        py,
        points[i] + offsetX,
        points[i + 1] + offsetY,
        points[i + 2] + offsetX,
        points[i + 3] + offsetY
      )
    )
  }

  if (closed && points.length >= 6) {
    best = Math.min(
      best,
      distanceToSegment(
        px,
        py,
        points[points.length - 2] + offsetX,
        points[points.length - 1] + offsetY,
        points[0] + offsetX,
        points[1] + offsetY
      )
    )
  }

  return best
}

/** Corner points of a diamond that fills the given box. */
function diamondPoints(width, height) {
  return [width / 2, 0, width, height / 2, width / 2, height, 0, height / 2]
}

/** A rough box for a text shape; Konva measures glyphs, we approximate. */
function textBox(shape) {
  const size = shape.fontSize || 16
  const lines = String(shape.text || '').split('\n')
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
  return {
    x: shape.x || 0,
    y: shape.y || 0,
    width: longest * size * 0.6,
    height: lines.length * size * 1.25,
  }
}

const inBox = (px, py, x, y, width, height, pad) =>
  px >= x - pad && px <= x + width + pad && py >= y - pad && py <= y + height + pad

/**
 * True when a circle of `radius` centred on (px, py) touches the shape.
 *
 * Closed shapes count as solid: clicking the empty middle of a rectangle
 * erases it, which is what people expect even when it has no fill.
 */
export function isShapeHit(shape, px, py, radius) {
  if (!shape) return false

  const offsetX = shape.x || 0
  const offsetY = shape.y || 0
  // A thick stroke should be no harder to hit than a thin one.
  const reach = radius + (shape.strokeWidth || 0) / 2

  switch (shape.type) {
    case 'line':
    case 'segment':
    case 'arrow':
      return distanceToPolyline(px, py, shape.points, offsetX, offsetY, false) <= reach

    case 'rect':
      return inBox(px, py, offsetX, offsetY, shape.width || 0, shape.height || 0, reach)

    case 'diamond': {
      const width = shape.width || 0
      const height = shape.height || 0
      // Inside the bounding box and within reach of an edge, or inside the
      // diamond proper: |dx|/w + |dy|/h <= 0.5 for a centred rhombus.
      const cx = offsetX + width / 2
      const cy = offsetY + height / 2
      if (width > 0 && height > 0) {
        const inside =
          Math.abs(px - cx) / width + Math.abs(py - cy) / height <= 0.5
        if (inside) return true
      }
      return (
        distanceToPolyline(px, py, diamondPoints(width, height), offsetX, offsetY, true) <= reach
      )
    }

    case 'ellipse': {
      const rx = (shape.radiusX || 0) + reach
      const ry = (shape.radiusY || 0) + reach
      if (rx <= 0 || ry <= 0) return false
      const nx = (px - offsetX) / rx
      const ny = (py - offsetY) / ry
      return nx * nx + ny * ny <= 1
    }

    case 'text': {
      const box = textBox(shape)
      return inBox(px, py, box.x, box.y, box.width, box.height, radius)
    }

    default:
      return false
  }
}

/** Ids of every shape the eraser circle touches, nearest-last order preserved. */
export function shapesHitBy(shapes, px, py, radius) {
  const hits = []
  for (const shape of shapes) {
    if (shape?.id && isShapeHit(shape, px, py, radius)) hits.push(shape.id)
  }
  return hits
}
