/**
 * What the replay viewer needs to know that is not React.
 *
 * Kept apart from the components for the same reason `files.js` is: these are
 * pure functions, and exporting them from a component file costs fast refresh
 * for the whole component.
 */

/** How long one step is held at 1x. Fast enough to read, slow enough to follow. */
export const STEP_MS = 420

export const SPEEDS = [
  { value: 0.5, label: '0.5×' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
]

/**
 * A drawing is never blown up past life size. Fitting a single small shape to
 * a full pane would show one enormous rectangle and no sense of where on the
 * board it sat.
 */
const MAX_FIT_SCALE = 1
const FIT_PADDING = 40

/** The camera that puts `box` fully inside `size`, centred. */
export function fitTo(box, size) {
  if (!box || !size?.width || !size?.height) return { scale: 1, x: 0, y: 0 }

  const usableWidth = Math.max(size.width - FIT_PADDING * 2, 1)
  const usableHeight = Math.max(size.height - FIT_PADDING * 2, 1)

  const scale = Math.min(
    usableWidth / Math.max(box.width, 1),
    usableHeight / Math.max(box.height, 1),
    MAX_FIT_SCALE
  )

  return {
    scale,
    x: FIT_PADDING + (usableWidth - box.width * scale) / 2 - box.x * scale,
    y: FIT_PADDING + (usableHeight - box.height * scale) / 2 - box.y * scale,
  }
}

/** Whether `outer` already covers `inner`, so the camera need not move. */
export function covers(outer, inner) {
  if (!outer) return false
  if (!inner) return true
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  )
}

/** The smallest box containing both. Either may be null. */
export function union(a, b) {
  if (!a) return b ? { ...b } : null
  if (!b) return { ...a }

  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x, y, width: right - x, height: bottom - y }
}

/** A timestamp as a clock reading, for a row that already says how long ago. */
export function formatClock(value) {
  if (!value) return ''
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Who made a change, from the actor id the log stores.
 *
 * The log records ids, not names, and the endpoint that resolves them needs an
 * account — so a name is a courtesy the viewer may not be able to offer. An
 * unattributed change came from someone editing without signing in.
 */
export function actorLabel(actor, names) {
  if (!actor) return 'A guest'
  return names?.get(String(actor)) || 'Someone'
}

/** Bytes for the size column, which is always small and never fractional. */
export function formatBytes(size) {
  const value = Number(size)
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return value + ' B'
  return Math.round(value / 1024) + ' KB'
}

/**
 * What a position in the log reads as. Index 0 is the state before anything
 * was recorded, so it has no entry of its own.
 */
export function describeStep(index, entries, names) {
  if (index <= 0) return { title: 'Before the first change', detail: '' }

  const entry = entries[index - 1]
  if (!entry) return { title: '', detail: '' }

  return {
    title: actorLabel(entry.actor, names),
    detail: [formatClock(entry.at), formatBytes(entry.size)].filter(Boolean).join(' · '),
  }
}
