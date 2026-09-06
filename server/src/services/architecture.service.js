/**
 * Reading a system design off the whiteboard.
 *
 * The whiteboard stores drawings, not diagrams. A box is a rectangle with a
 * position; an arrow is four numbers; a label is an unrelated text shape that
 * happens to sit on top of a box. Nothing records that the arrow between
 * "API" and "Database" *means* anything, because when someone drew it they
 * were drawing, not modelling.
 *
 * So the structure has to be recovered geometrically, and this file is where
 * that happens. It is deliberately the only place: everything downstream —
 * the preview the user checks before generating, the prompt the model sees,
 * the record kept afterwards — works from the graph produced here, so there is
 * one definition of what the picture meant and it can be tested without an AI
 * anywhere near it.
 *
 * It is inference, and it is sometimes wrong. That is why `warnings` exists
 * and why the UI shows the graph before anything is generated: the answer to a
 * misread diagram should be the person fixing it, not the model guessing.
 */

/** Shapes that can stand for a component. */
const CONTAINERS = new Set(['rect', 'diamond', 'ellipse'])

/** Shapes that can stand for a relationship. `arrow` is the only directed one. */
const CONNECTORS = new Set(['arrow', 'segment'])

/**
 * How far an endpoint may sit from a shape and still be counted as touching
 * it, in world units.
 *
 * People do not draw to the pixel, and an arrow that stops just short of a box
 * means the same thing as one that lands inside it. Too small and ordinary
 * diagrams come out disconnected; too large and an arrow passing near an
 * unrelated box gets attached to it. This is roughly a comfortable gap at
 * normal zoom.
 */
const ENDPOINT_TOLERANCE = 60

/**
 * How far a text shape may sit from an edge's midpoint to be read as that
 * edge's label rather than as a free-floating note.
 *
 * Tighter than the endpoint tolerance: an edge label is written *on* the line,
 * while a note is placed deliberately away from things.
 */
const EDGE_LABEL_TOLERANCE = 48

/** Rough width of a character relative to font size, for text bounds. */
const CHAR_ASPECT = 0.55

/**
 * The rectangle a shape occupies, or null if it has none.
 *
 * The three container types disagree about what `x, y` means, which is a
 * detail of how Konva draws them rather than anything the document explains:
 * a rect and a diamond are positioned by their top-left corner, an ellipse by
 * its centre. Getting this wrong offsets every ellipse by its own radius and
 * quietly attaches arrows to the wrong things.
 */
export function boundsOf(shape) {
  if (!shape) return null
  const x = Number(shape.x) || 0
  const y = Number(shape.y) || 0

  if (shape.type === 'rect' || shape.type === 'diamond') {
    const width = Number(shape.width) || 0
    const height = Number(shape.height) || 0
    if (width <= 0 || height <= 0) return null
    return { left: x, top: y, right: x + width, bottom: y + height }
  }

  if (shape.type === 'ellipse') {
    const rx = Number(shape.radiusX) || 0
    const ry = Number(shape.radiusY) || 0
    if (rx <= 0 || ry <= 0) return null
    return { left: x - rx, top: y - ry, right: x + rx, bottom: y + ry }
  }

  if (shape.type === 'text') {
    const text = String(shape.text ?? '')
    const size = Number(shape.fontSize) || 16
    const lines = text.split('\n')
    const longest = lines.reduce((most, line) => Math.max(most, line.length), 0)
    // Estimated, because the document stores no measured box for text — only
    // the string and its size. Good enough to decide which box it sits in.
    return {
      left: x,
      top: y,
      right: x + longest * size * CHAR_ASPECT,
      bottom: y + lines.length * size * 1.2,
    }
  }

  return null
}

export const centreOf = (bounds) =>
  bounds ? { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 } : null

const contains = (bounds, point) =>
  Boolean(bounds) &&
  point.x >= bounds.left &&
  point.x <= bounds.right &&
  point.y >= bounds.top &&
  point.y <= bounds.bottom

/** Distance from a point to the nearest spot on a rectangle; 0 when inside. */
export function distanceToBounds(bounds, point) {
  if (!bounds) return Infinity
  const dx = Math.max(bounds.left - point.x, 0, point.x - bounds.right)
  const dy = Math.max(bounds.top - point.y, 0, point.y - bounds.bottom)
  return Math.hypot(dx, dy)
}

const area = (bounds) =>
  bounds ? Math.max(bounds.right - bounds.left, 0) * Math.max(bounds.bottom - bounds.top, 0) : 0

/**
 * The endpoints of a connector, in world coordinates.
 *
 * Connectors are stored with `x, y` at the origin and absolute points, which
 * is what the drawing code happens to do rather than a guarantee — so the
 * offset is added rather than assumed to be zero.
 */
export function endpointsOf(shape) {
  const points = Array.isArray(shape?.points) ? shape.points : null
  if (!points || points.length < 4) return null

  const x = Number(shape.x) || 0
  const y = Number(shape.y) || 0

  return {
    from: { x: x + Number(points[0]), y: y + Number(points[1]) },
    to: { x: x + Number(points[points.length - 2]), y: y + Number(points[points.length - 1]) },
  }
}

/**
 * The container an endpoint belongs to, or null.
 *
 * Ties are broken towards the smaller shape. A diagram that groups boxes
 * inside a larger boundary box is common, and without this every arrow inside
 * the group would attach to the group rather than to what it actually points
 * at.
 */
function containerAt(point, containers, tolerance = ENDPOINT_TOLERANCE) {
  let best = null
  let bestDistance = Infinity

  for (const candidate of containers) {
    const distance = distanceToBounds(candidate.bounds, point)
    if (distance > tolerance) continue

    const closer = distance < bestDistance - 0.001
    const tied = Math.abs(distance - bestDistance) <= 0.001
    if (closer || (tied && best && area(candidate.bounds) < area(best.bounds))) {
      best = candidate
      bestDistance = distance
    }
  }

  return best
}

/**
 * What a component appears to be, from its shape and what it is called.
 *
 * Only a hint. It gives the model somewhere to start and gives the reader
 * something to correct, but nothing downstream refuses to work because a node
 * came out as `service` when it was meant to be a worker.
 */
const TYPE_HINTS = [
  { type: 'datastore', test: /\b(db|database|postgres|mysql|mongo|sql|store|storage|table|schema)\b/i },
  { type: 'cache', test: /\b(cache|redis|memcached)\b/i },
  { type: 'queue', test: /\b(queue|broker|kafka|rabbit|sqs|topic|stream|events?)\b/i },
  { type: 'gateway', test: /\b(gateway|proxy|load ?balancer|nginx|ingress|router)\b/i },
  { type: 'api', test: /\b(api|rest|graphql|endpoint|controller)\b/i },
  { type: 'auth', test: /\b(auth|login|identity|oauth|jwt|session|token)\b/i },
  { type: 'client', test: /\b(client|browser|frontend|front-end|ui|web|mobile|app)\b/i },
  { type: 'worker', test: /\b(worker|job|cron|scheduler|batch|consumer)\b/i },
  { type: 'external', test: /\b(third[- ]party|external|vendor|stripe|s3|smtp|email)\b/i },
  { type: 'service', test: /\b(service|server|backend|micro)\b/i },
]

export function inferNodeType(shape, label) {
  const text = String(label ?? '').trim()

  if (text) {
    const hit = TYPE_HINTS.find((hint) => hint.test.test(text))
    if (hit) return hit.type
  }

  // Shape conventions, used only when the words say nothing. A diamond is a
  // decision in every flowchart convention there is; a cylinder would be a
  // datastore, and an ellipse is the nearest thing this toolbar offers.
  if (shape.type === 'diamond') return 'decision'
  if (shape.type === 'ellipse') return 'external'
  return 'component'
}

/** A stable, readable key for a node, used in prompts and generated code. */
function slugify(value, fallback) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || fallback
}

/**
 * Turns a room's shapes into an architecture graph.
 *
 * Everything here is inference from geometry, so every step that could be
 * wrong records why rather than failing: a diagram with no boxes, an arrow
 * joining nothing, a box nobody labelled. Those become `warnings`, which the
 * UI shows and the prompt repeats, because "you drew an arrow from nothing"
 * is far more useful to the person than a confident guess.
 */
export function extractArchitecture(shapes = []) {
  const list = Array.isArray(shapes) ? shapes.filter(Boolean) : []

  const containers = []
  const connectors = []
  const texts = []

  for (const shape of list) {
    if (CONTAINERS.has(shape.type)) {
      const bounds = boundsOf(shape)
      if (bounds) containers.push({ shape, bounds })
    } else if (CONNECTORS.has(shape.type)) {
      const ends = endpointsOf(shape)
      if (ends) connectors.push({ shape, ends })
    } else if (shape.type === 'text' && String(shape.text ?? '').trim()) {
      texts.push({ shape, bounds: boundsOf(shape) })
    }
  }

  const warnings = []

  /**
   * Labels first, because the node type depends on the words and the edge
   * labels depend on which texts are left over.
   *
   * A text belongs to the container its own centre falls inside — not the
   * nearest one. Proximity would let a caption written just below a box get
   * claimed by it, and "nearest" has no natural stopping point when boxes are
   * packed together.
   */
  const labelsByShapeId = new Map()
  const unclaimed = []

  for (const entry of texts) {
    const anchor = centreOf(entry.bounds) ?? { x: entry.shape.x, y: entry.shape.y }
    const inside = containers
      .filter((candidate) => contains(candidate.bounds, anchor))
      // Innermost wins, so a label inside a box inside a group labels the box.
      .sort((a, b) => area(a.bounds) - area(b.bounds))[0]

    if (!inside) {
      unclaimed.push(entry)
      continue
    }

    const existing = labelsByShapeId.get(inside.shape.id)
    const text = String(entry.shape.text).trim()
    // Several texts in one box read top to bottom: the first is the name, the
    // rest are description.
    labelsByShapeId.set(
      inside.shape.id,
      existing ? [...existing, { text, y: entry.bounds.top }] : [{ text, y: entry.bounds.top }]
    )
  }

  const usedSlugs = new Set()
  const nodes = containers.map((entry) => {
    const parts = (labelsByShapeId.get(entry.shape.id) ?? [])
      .slice()
      .sort((a, b) => a.y - b.y)
      .map((part) => part.text)

    const label = parts[0] ?? null
    const description = parts.slice(1).join(' ') || null

    let key = slugify(label, 'node-' + entry.shape.id)
    // Two boxes may legitimately carry the same word; the key still has to be
    // unique because it is what edges and generated filenames refer to.
    if (usedSlugs.has(key)) key = key + '-' + entry.shape.id
    usedSlugs.add(key)

    if (!label) {
      warnings.push({
        code: 'unlabelled_node',
        message: 'A ' + entry.shape.type + ' has no text in it, so there is nothing to call it.',
        shapeId: entry.shape.id,
      })
    }

    return {
      id: entry.shape.id,
      key,
      type: inferNodeType(entry.shape, label),
      label: label ?? 'Unnamed ' + entry.shape.type,
      description,
      shape: entry.shape.type,
      bounds: entry.bounds,
      author: entry.shape.authorName ?? null,
      createdAt: entry.shape.createdAt ?? null,
    }
  })

  const nodesByShapeId = new Map(nodes.map((node) => [node.id, node]))

  /** Edges, with whatever leftover text sits on them as the relationship. */
  const edges = []

  for (const entry of connectors) {
    const tail = containerAt(entry.ends.from, containers)
    const head = containerAt(entry.ends.to, containers)

    if (!tail || !head) {
      warnings.push({
        code: 'dangling_connector',
        message:
          'An ' +
          entry.shape.type +
          ' does not reach a box at ' +
          (tail ? 'its head' : head ? 'its tail' : 'either end') +
          ', so it could not be read as a connection.',
        shapeId: entry.shape.id,
      })
      continue
    }

    if (tail.shape.id === head.shape.id) {
      warnings.push({
        code: 'self_connector',
        message: 'An ' + entry.shape.type + ' starts and ends on the same box.',
        shapeId: entry.shape.id,
      })
      continue
    }

    const midpoint = {
      x: (entry.ends.from.x + entry.ends.to.x) / 2,
      y: (entry.ends.from.y + entry.ends.to.y) / 2,
    }

    let relationship = null
    let closest = EDGE_LABEL_TOLERANCE
    let claimedIndex = -1

    unclaimed.forEach((candidate, index) => {
      if (candidate.claimed) return
      /**
       * Measured to the nearest corner of the text, not to its centre. A
       * label is written *beside* the line it belongs to, so its centre sits
       * half its own width away — and the longer the label, the further away
       * it appears to be, which would mean "reads and writes" got dropped
       * while "rw" was kept.
       */
      const distance = distanceToBounds(candidate.bounds, midpoint)
      if (distance < closest) {
        closest = distance
        relationship = String(candidate.shape.text).trim()
        claimedIndex = index
      }
    })

    if (claimedIndex >= 0) unclaimed[claimedIndex].claimed = true

    edges.push({
      id: entry.shape.id,
      source: nodesByShapeId.get(tail.shape.id).key,
      target: nodesByShapeId.get(head.shape.id).key,
      sourceId: tail.shape.id,
      targetId: head.shape.id,
      // A segment is a line between two things with no direction drawn on it;
      // saying which way it points would be inventing information.
      directed: entry.shape.type === 'arrow',
      relationship,
      author: entry.shape.authorName ?? null,
    })
  }

  const notes = unclaimed
    .filter((entry) => !entry.claimed)
    .map((entry) => ({
      id: entry.shape.id,
      text: String(entry.shape.text).trim(),
      author: entry.shape.authorName ?? null,
    }))

  // Nodes nothing joins. Not an error — a legend or a to-do box is a perfectly
  // ordinary thing to draw — but worth saying, because the usual cause is an
  // arrow that missed.
  const connected = new Set(edges.flatMap((edge) => [edge.sourceId, edge.targetId]))
  for (const node of nodes) {
    if (!connected.has(node.id)) {
      warnings.push({
        code: 'isolated_node',
        message: '"' + node.label + '" is not connected to anything.',
        shapeId: node.id,
      })
    }
  }

  if (nodes.length === 0) {
    warnings.push({
      code: 'no_components',
      message:
        'No boxes were found. Draw rectangles, diamonds or ellipses for the parts of the system, ' +
        'and put a text label inside each one.',
      shapeId: null,
    })
  }

  const duplicates = new Map()
  for (const node of nodes) {
    const key = node.label.toLowerCase()
    duplicates.set(key, (duplicates.get(key) ?? 0) + 1)
  }
  for (const [label, count] of duplicates) {
    if (count > 1) {
      warnings.push({
        code: 'duplicate_label',
        message: count + ' boxes are labelled "' + label + '", which may be one thing drawn twice.',
        shapeId: null,
      })
    }
  }

  return {
    nodes: nodes.map(({ bounds: _bounds, ...node }) => node),
    edges,
    notes,
    warnings,
    stats: {
      shapes: list.length,
      containers: containers.length,
      connectors: connectors.length,
      texts: texts.length,
    },
  }
}

/**
 * The graph as compact text for a prompt.
 *
 * JSON would carry ids, coordinates and authorship that mean nothing to a
 * model asked to design software, and every one of those tokens is paid for
 * on each request. This keeps what describes the system and drops what
 * describes the drawing.
 */
export function architectureToPrompt(architecture) {
  const lines = []

  lines.push('COMPONENTS')
  if (architecture.nodes.length === 0) {
    lines.push('  (none identified)')
  }
  for (const node of architecture.nodes) {
    lines.push(
      '  - ' + node.key + ' [' + node.type + '] "' + node.label + '"' +
        (node.description ? ' — ' + node.description : '')
    )
  }

  lines.push('')
  lines.push('CONNECTIONS')
  if (architecture.edges.length === 0) {
    lines.push('  (none identified)')
  }
  for (const edge of architecture.edges) {
    lines.push(
      '  - ' + edge.source + (edge.directed ? ' -> ' : ' -- ') + edge.target +
        (edge.relationship ? ' : ' + edge.relationship : '')
    )
  }

  if (architecture.notes.length > 0) {
    lines.push('')
    lines.push('NOTES ON THE DIAGRAM')
    for (const note of architecture.notes) lines.push('  - ' + note.text)
  }

  if (architecture.warnings.length > 0) {
    lines.push('')
    lines.push('THINGS THAT COULD NOT BE READ FROM THE DIAGRAM')
    for (const warning of architecture.warnings) lines.push('  - ' + warning.message)
  }

  return lines.join('\n')
}
