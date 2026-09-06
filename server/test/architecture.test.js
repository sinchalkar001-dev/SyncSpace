import { describe, expect, it } from 'vitest'
import {
  architectureToPrompt,
  boundsOf,
  distanceToBounds,
  endpointsOf,
  extractArchitecture,
  inferNodeType,
} from '../src/services/architecture.service.js'

/**
 * Reading a system design off the whiteboard.
 *
 * Nothing in the document says an arrow *connects* anything — it is four
 * numbers — and nothing says a label belongs to a box; it is a separate text
 * shape that happens to sit on top of one. The whole graph is recovered from
 * geometry, so these tests are about geometry: what counts as touching, what
 * counts as inside, and what happens when a diagram is drawn imperfectly,
 * which is how diagrams are always drawn.
 */

let counter = 0
const id = () => 'sh' + (counter += 1)

const box = (label, x, y, extra = {}) => {
  const shapeId = id()
  const width = extra.width ?? 120
  const height = extra.height ?? 60
  const shapes = [
    {
      id: shapeId,
      type: extra.type ?? 'rect',
      x,
      y,
      width,
      height,
      stroke: '#fff',
      strokeWidth: 2,
      authorName: extra.author ?? 'Ada',
      createdAt: 1,
    },
  ]
  if (label !== null) {
    // Centred in the box, the way a person labels one.
    shapes.push({
      id: id(),
      type: 'text',
      x: x + 12,
      y: y + height / 2 - 8,
      text: label,
      fontSize: 16,
      stroke: '#fff',
      strokeWidth: 0,
      authorName: extra.author ?? 'Ada',
      createdAt: 1,
    })
  }
  return { id: shapeId, shapes }
}

const arrow = (from, to, type = 'arrow') => ({
  id: id(),
  type,
  x: 0,
  y: 0,
  points: [from.x, from.y, to.x, to.y],
  stroke: '#fff',
  strokeWidth: 2,
  authorName: 'Ada',
  createdAt: 1,
})

const text = (value, x, y) => ({
  id: id(),
  type: 'text',
  x,
  y,
  text: value,
  fontSize: 16,
  stroke: '#fff',
  strokeWidth: 0,
  authorName: 'Ada',
  createdAt: 1,
})

/** The diagram from the brief: Client -> API -> Auth Service -> Database. */
function stack() {
  const client = box('Client', 100, 0)
  const api = box('API', 100, 200)
  const auth = box('Auth Service', 100, 400)
  const db = box('Database', 100, 600)

  return {
    client,
    api,
    auth,
    db,
    shapes: [
      ...client.shapes,
      ...api.shapes,
      ...auth.shapes,
      ...db.shapes,
      arrow({ x: 160, y: 60 }, { x: 160, y: 200 }),
      arrow({ x: 160, y: 260 }, { x: 160, y: 400 }),
      arrow({ x: 160, y: 460 }, { x: 160, y: 600 }),
    ],
  }
}

describe('boundsOf', () => {
  it('positions a rect from its top-left corner', () => {
    expect(boundsOf({ type: 'rect', x: 10, y: 20, width: 100, height: 50 })).toEqual({
      left: 10,
      top: 20,
      right: 110,
      bottom: 70,
    })
  })

  /**
   * The one that would silently ruin everything. Konva centres an ellipse on
   * its x/y while a rect hangs off it, and the document says nothing about the
   * difference — treating them alike offsets every ellipse by its own radius
   * and attaches arrows to whatever is next door.
   */
  it('positions an ellipse from its centre, not its corner', () => {
    expect(boundsOf({ type: 'ellipse', x: 100, y: 100, radiusX: 40, radiusY: 20 })).toEqual({
      left: 60,
      top: 80,
      right: 140,
      bottom: 120,
    })
  })

  it('gives a diamond the bounds of the box it was dragged out in', () => {
    expect(boundsOf({ type: 'diamond', x: 0, y: 0, width: 80, height: 40 })).toEqual({
      left: 0,
      top: 0,
      right: 80,
      bottom: 40,
    })
  })

  it('has nothing to say about a shape with no size', () => {
    expect(boundsOf({ type: 'rect', x: 0, y: 0, width: 0, height: 10 })).toBeNull()
    expect(boundsOf({ type: 'ellipse', x: 0, y: 0, radiusX: 0, radiusY: 5 })).toBeNull()
    expect(boundsOf(null)).toBeNull()
  })

  it('estimates a text box from the string, since none is stored', () => {
    const bounds = boundsOf({ type: 'text', x: 0, y: 0, text: 'Database', fontSize: 20 })
    expect(bounds.right).toBeGreaterThan(bounds.left)
    expect(bounds.bottom).toBeGreaterThan(bounds.top)
  })

  it('grows a text box for a second line', () => {
    const one = boundsOf({ type: 'text', x: 0, y: 0, text: 'a', fontSize: 16 })
    const two = boundsOf({ type: 'text', x: 0, y: 0, text: 'a\nb', fontSize: 16 })
    expect(two.bottom).toBeGreaterThan(one.bottom)
  })
})

describe('distanceToBounds', () => {
  const bounds = { left: 0, top: 0, right: 100, bottom: 100 }

  it('is zero inside', () => {
    expect(distanceToBounds(bounds, { x: 50, y: 50 })).toBe(0)
  })

  it('measures to the nearest edge, not the centre', () => {
    expect(distanceToBounds(bounds, { x: 110, y: 50 })).toBe(10)
  })

  it('measures diagonally past a corner', () => {
    expect(distanceToBounds(bounds, { x: 103, y: 104 })).toBeCloseTo(5)
  })
})

describe('endpointsOf', () => {
  it('reads the first and last point', () => {
    expect(endpointsOf({ x: 0, y: 0, points: [1, 2, 3, 4] })).toEqual({
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
    })
  })

  /** Connectors are stored at the origin today; that is a habit, not a promise. */
  it('adds the shape offset rather than assuming it is zero', () => {
    expect(endpointsOf({ x: 10, y: 20, points: [1, 2, 3, 4] })).toEqual({
      from: { x: 11, y: 22 },
      to: { x: 13, y: 24 },
    })
  })

  it('uses the ends of a multi-point line', () => {
    expect(endpointsOf({ x: 0, y: 0, points: [0, 0, 5, 5, 9, 9] })).toEqual({
      from: { x: 0, y: 0 },
      to: { x: 9, y: 9 },
    })
  })

  it('refuses a connector with nothing to read', () => {
    expect(endpointsOf({ points: [1, 2] })).toBeNull()
    expect(endpointsOf({})).toBeNull()
  })
})

describe('inferNodeType', () => {
  const rect = { type: 'rect' }

  it('recognises the usual parts of a system by name', () => {
    expect(inferNodeType(rect, 'Postgres Database')).toBe('datastore')
    expect(inferNodeType(rect, 'Redis cache')).toBe('cache')
    expect(inferNodeType(rect, 'Kafka topic')).toBe('queue')
    expect(inferNodeType(rect, 'API Gateway')).toBe('gateway')
    expect(inferNodeType(rect, 'Auth Service')).toBe('auth')
    expect(inferNodeType(rect, 'Client')).toBe('client')
  })

  /** "Auth Service" is both; auth is the more specific answer. */
  it('prefers the more specific reading when a label matches twice', () => {
    expect(inferNodeType(rect, 'Auth Service')).toBe('auth')
    expect(inferNodeType(rect, 'Payments Service')).toBe('service')
  })

  it('falls back to the shape when the words say nothing', () => {
    expect(inferNodeType({ type: 'diamond' }, 'Is it valid?')).toBe('decision')
    expect(inferNodeType({ type: 'ellipse' }, 'Somewhere')).toBe('external')
    expect(inferNodeType(rect, 'Thing')).toBe('component')
  })

  it('has an answer for a box nobody labelled', () => {
    expect(inferNodeType(rect, null)).toBe('component')
    expect(inferNodeType(rect, '   ')).toBe('component')
  })
})

describe('extractArchitecture', () => {
  it('reads the diagram from the brief end to end', () => {
    const { shapes } = stack()
    const result = extractArchitecture(shapes)

    expect(result.nodes.map((node) => node.label)).toEqual([
      'Client',
      'API',
      'Auth Service',
      'Database',
    ])
    expect(result.edges.map((edge) => edge.source + '->' + edge.target)).toEqual([
      'client->api',
      'api->auth-service',
      'auth-service->database',
    ])
  })

  it('types the components it recognises', () => {
    const result = extractArchitecture(stack().shapes)
    expect(result.nodes.map((node) => node.type)).toEqual(['client', 'api', 'auth', 'datastore'])
  })

  /** A text shape is independent of the box; only geometry links them. */
  it('takes a box label from the text sitting inside it', () => {
    const b = box('Payments', 0, 0)
    const result = extractArchitecture(b.shapes)

    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].label).toBe('Payments')
  })

  it('reads a second line inside a box as its description', () => {
    const b = box('Orders', 0, 0, { height: 120 })
    const result = extractArchitecture([...b.shapes, text('handles checkout', 12, 80)])

    expect(result.nodes[0].label).toBe('Orders')
    expect(result.nodes[0].description).toBe('handles checkout')
  })

  it('labels the inner box when one box sits inside another', () => {
    const outer = box(null, 0, 0, { width: 400, height: 300 })
    const inner = box('Inner', 100, 100)
    const result = extractArchitecture([...outer.shapes, ...inner.shapes])

    const named = result.nodes.find((node) => node.label === 'Inner')
    expect(named).toBeDefined()
    expect(named.id).toBe(inner.id)
  })

  /**
   * Nobody lands an arrow exactly on a border. An arrow that stops a little
   * short means what an arrow that overlaps means, and requiring a hit would
   * make ordinary diagrams come out as a pile of disconnected boxes.
   */
  it('connects an arrow that stops short of the box', () => {
    const a = box('A', 0, 0)
    const b = box('B', 0, 300)
    const result = extractArchitecture([
      ...a.shapes,
      ...b.shapes,
      arrow({ x: 60, y: 75 }, { x: 60, y: 285 }),
    ])

    expect(result.edges).toHaveLength(1)
    expect(result.edges[0].source).toBe('a')
    expect(result.edges[0].target).toBe('b')
  })

  it('connects an arrow that overshoots into the box', () => {
    const a = box('A', 0, 0)
    const b = box('B', 0, 300)
    const result = extractArchitecture([
      ...a.shapes,
      ...b.shapes,
      arrow({ x: 60, y: 30 }, { x: 60, y: 330 }),
    ])

    expect(result.edges).toHaveLength(1)
  })

  it('keeps the direction the arrow was drawn in', () => {
    const a = box('A', 0, 0)
    const b = box('B', 0, 300)
    const result = extractArchitecture([
      ...a.shapes,
      ...b.shapes,
      arrow({ x: 60, y: 310 }, { x: 60, y: 50 }),
    ])

    expect(result.edges[0].source).toBe('b')
    expect(result.edges[0].target).toBe('a')
  })

  /** A plain line says two things are related, not which way it flows. */
  it('marks a segment undirected and an arrow directed', () => {
    const a = box('A', 0, 0)
    const b = box('B', 0, 300)
    const shapes = [...a.shapes, ...b.shapes]

    const arrowed = extractArchitecture([...shapes, arrow({ x: 60, y: 60 }, { x: 60, y: 300 })])
    const lined = extractArchitecture([
      ...shapes,
      arrow({ x: 60, y: 60 }, { x: 60, y: 300 }, 'segment'),
    ])

    expect(arrowed.edges[0].directed).toBe(true)
    expect(lined.edges[0].directed).toBe(false)
  })

  it('reads a word written on a connector as the relationship', () => {
    const a = box('API', 0, 0)
    const b = box('Database', 0, 300)
    const result = extractArchitecture([
      ...a.shapes,
      ...b.shapes,
      arrow({ x: 60, y: 60 }, { x: 60, y: 300 }),
      text('reads/writes', 70, 175),
    ])

    expect(result.edges[0].relationship).toBe('reads/writes')
    // Claimed by the edge, so it is not also reported as a loose note.
    expect(result.notes).toHaveLength(0)
  })

  it('keeps text that is far from everything as a note', () => {
    const a = box('A', 0, 0)
    const result = extractArchitecture([...a.shapes, text('TODO: rate limiting', 900, 900)])

    expect(result.notes.map((note) => note.text)).toEqual(['TODO: rate limiting'])
  })

  it('gives every node a unique key even when two are named the same', () => {
    const first = box('Service', 0, 0)
    const second = box('Service', 400, 0)
    const result = extractArchitecture([...first.shapes, ...second.shapes])

    const keys = result.nodes.map((node) => node.key)
    expect(new Set(keys).size).toBe(2)
  })

  it('carries who drew what', () => {
    const a = box('A', 0, 0, { author: 'Grace' })
    const result = extractArchitecture(a.shapes)
    expect(result.nodes[0].author).toBe('Grace')
  })

  it('ignores freehand scribbles and the eraser leftovers', () => {
    const a = box('A', 0, 0)
    const result = extractArchitecture([
      ...a.shapes,
      { id: id(), type: 'line', x: 0, y: 0, points: [0, 0, 5, 5, 10, 10], stroke: '#fff' },
    ])

    expect(result.nodes).toHaveLength(1)
    expect(result.edges).toHaveLength(0)
  })

  it('survives an empty board', () => {
    const result = extractArchitecture([])
    expect(result.nodes).toEqual([])
    expect(result.edges).toEqual([])
    expect(result.warnings.some((w) => w.code === 'no_components')).toBe(true)
  })

  it('survives rubbish input rather than throwing', () => {
    expect(() => extractArchitecture(null)).not.toThrow()
    expect(() => extractArchitecture([null, undefined, {}, { type: 'rect' }])).not.toThrow()
  })
})

describe('what it could not read', () => {
  /**
   * These are the point of the feature being structured rather than a
   * screenshot: the user is told what the diagram failed to say, instead of
   * the model quietly inventing it.
   */
  it('reports an arrow that reaches nothing', () => {
    const a = box('A', 0, 0)
    const result = extractArchitecture([
      ...a.shapes,
      arrow({ x: 60, y: 60 }, { x: 2000, y: 2000 }),
    ])

    const warning = result.warnings.find((w) => w.code === 'dangling_connector')
    expect(warning).toBeDefined()
    expect(result.edges).toHaveLength(0)
  })

  it('reports a box nobody labelled', () => {
    const result = extractArchitecture(box(null, 0, 0).shapes)
    expect(result.warnings.some((w) => w.code === 'unlabelled_node')).toBe(true)
  })

  it('reports a box joined to nothing', () => {
    const a = box('A', 0, 0)
    const b = box('B', 0, 300)
    const lonely = box('Lonely', 900, 900)
    const result = extractArchitecture([
      ...a.shapes,
      ...b.shapes,
      ...lonely.shapes,
      arrow({ x: 60, y: 60 }, { x: 60, y: 300 }),
    ])

    const isolated = result.warnings.filter((w) => w.code === 'isolated_node')
    expect(isolated).toHaveLength(1)
    expect(isolated[0].message).toContain('Lonely')
  })

  it('reports two boxes with the same name', () => {
    const first = box('Service', 0, 0)
    const second = box('Service', 400, 0)
    const result = extractArchitecture([...first.shapes, ...second.shapes])

    expect(result.warnings.some((w) => w.code === 'duplicate_label')).toBe(true)
  })

  it('reports an arrow that loops back to its own box', () => {
    const a = box('A', 0, 0)
    const result = extractArchitecture([
      ...a.shapes,
      arrow({ x: 10, y: 10 }, { x: 100, y: 50 }),
    ])

    expect(result.warnings.some((w) => w.code === 'self_connector')).toBe(true)
    expect(result.edges).toHaveLength(0)
  })

  it('says nothing is wrong with a diagram that is fine', () => {
    const result = extractArchitecture(stack().shapes)
    expect(result.warnings).toEqual([])
  })
})

describe('architectureToPrompt', () => {
  it('describes the system and not the drawing', () => {
    const prompt = architectureToPrompt(extractArchitecture(stack().shapes))

    expect(prompt).toContain('client [client] "Client"')
    expect(prompt).toContain('client -> api')
    expect(prompt).toContain('auth-service -> database')
    // Coordinates, ids and authorship describe the picture, not the system.
    expect(prompt).not.toMatch(/\bx:|\bbounds\b|createdAt/)
  })

  it('passes on what could not be read, so the model does not invent it', () => {
    const a = box('A', 0, 0)
    const architecture = extractArchitecture([
      ...a.shapes,
      arrow({ x: 60, y: 60 }, { x: 2000, y: 2000 }),
    ])

    expect(architectureToPrompt(architecture)).toContain('COULD NOT BE READ')
  })

  it('says so plainly when there is nothing on the board', () => {
    const prompt = architectureToPrompt(extractArchitecture([]))
    expect(prompt).toContain('(none identified)')
  })
})
