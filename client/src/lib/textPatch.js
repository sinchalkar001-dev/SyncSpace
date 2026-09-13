/**
 * Putting a proposed buffer into the shared document without trampling it.
 *
 * The copilot proposes a whole replacement, never a diff — a model writing a
 * unified diff against a document three people are editing is a merge conflict
 * waiting for somebody to press a button. But applying a whole replacement
 * naively is just as bad: `delete(0, length); insert(0, next)` rewrites every
 * character, so every remote cursor jumps to the top, every comment anchored
 * to a line loses it, and the update log records the whole file as changed
 * when one line did.
 *
 * So the replacement is narrowed here to the part that actually differs, and
 * applied as one delete and one insert inside a single transaction. Two rules
 * make that safe:
 *
 *  - The buffer must still read exactly as the model was shown it. If anybody
 *    typed while the model was thinking, the patch is refused rather than
 *    applied over the difference. This is the whole of "never overwrite user
 *    data without explicit approval": the approval was given for a change to
 *    the text somebody read, and that is no longer the text in front of them.
 *  - One transaction, with an origin. Undo groups it as a single step, and
 *    everybody else in the room receives it as an ordinary edit rather than as
 *    a document that changed with no author.
 */

/** Marks a change as this person accepting a copilot proposal. */
export const COPILOT_ORIGIN = 'copilot'

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff

/**
 * The narrowest edit that turns `before` into `after`.
 *
 * Common prefix and common suffix, which for the shape of change a model
 * actually proposes — a line rewritten, a block inserted, a function replaced
 * — is very close to minimal, and costs one pass rather than the quadratic
 * time a real diff would.
 *
 * The surrogate handling is not hypothetical: an emoji in a comment, or any
 * character outside the basic plane, is two code units, and a prefix that ends
 * between them would insert half a character. The boundary is pulled back
 * until it sits between whole characters.
 */
export function diffBounds(before, after) {
  if (before === after) return null

  const max = Math.min(before.length, after.length)

  let start = 0
  while (start < max && before[start] === after[start]) start += 1
  // Never split a surrogate pair.
  if (start > 0 && isLowSurrogate(before.charCodeAt(start)) && isHighSurrogate(before.charCodeAt(start - 1))) {
    start -= 1
  }

  let end = 0
  while (
    end < max - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1
  }
  if (
    end > 0 &&
    isHighSurrogate(before.charCodeAt(before.length - end)) &&
    isLowSurrogate(before.charCodeAt(before.length - end + 1))
  ) {
    end -= 1
  }

  return {
    start,
    removed: before.length - end - start,
    inserted: after.slice(start, after.length - end),
  }
}

/**
 * How a change would read in a review: the lines it touches.
 *
 * Whole lines rather than characters, because a reviewer reads lines. Computed
 * from the same bounds the edit uses, so what is shown is what would happen.
 */
export function describeChange(before, after) {
  const bounds = diffBounds(before, after)
  if (!bounds) return { changed: false, removed: [], added: [], firstLine: 1 }

  const firstLine = before.slice(0, bounds.start).split('\n').length

  // Expanded to line boundaries so a change inside a line is shown as that
  // whole line rather than as three characters with no context.
  const lineStart = before.lastIndexOf('\n', bounds.start - 1) + 1
  const removedEnd = bounds.start + bounds.removed
  const insertedEnd = bounds.start + bounds.inserted.length

  const removedTail = before.indexOf('\n', removedEnd)
  const addedTail = after.indexOf('\n', insertedEnd)

  const removed = before.slice(lineStart, removedTail === -1 ? before.length : removedTail)
  const added = after.slice(lineStart, addedTail === -1 ? after.length : addedTail)

  return {
    changed: true,
    firstLine,
    removed: removed === '' ? [] : removed.split('\n'),
    added: added === '' ? [] : added.split('\n'),
  }
}

/**
 * Applies a proposed buffer, or explains why it was not applied.
 *
 * Answers `{ applied, reason }`. `reason` is `'stale'` when the buffer has
 * moved since the model read it and `'unchanged'` when the proposal is what is
 * already there — both of which are outcomes worth recording and telling
 * somebody about, not errors.
 */
export function applyPatch(yText, { baseText, contents }) {
  if (!yText) return { applied: false, reason: 'no_buffer' }

  const current = yText.toString()

  if (current !== baseText) return { applied: false, reason: 'stale' }

  const bounds = diffBounds(current, contents)
  if (!bounds) return { applied: false, reason: 'unchanged' }

  /**
   * One transaction, tagged. Two separate calls would be two updates in the
   * log and two steps to undo, and a moment in between where the buffer held
   * neither the old text nor the new — which anybody watching would see.
   */
  yText.doc.transact(() => {
    if (bounds.removed > 0) yText.delete(bounds.start, bounds.removed)
    if (bounds.inserted) yText.insert(bounds.start, bounds.inserted)
  }, COPILOT_ORIGIN)

  return { applied: true, reason: null }
}
