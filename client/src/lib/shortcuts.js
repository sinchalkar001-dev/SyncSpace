/**
 * Whether a keystroke was typed into a text field other than the surface a
 * shortcut belongs to.
 *
 * Room-wide shortcuts listen on the window in the capture phase, so that
 * Monaco — which handles keys on its own textarea and stops them travelling —
 * cannot hide them. The price is that they hear every field in the room:
 * Ctrl+Enter in the comment box used to send the comment and run the program.
 * A shortcut that belongs to one surface asks this first, and leaves keys
 * typed into anybody else's field to that field.
 */
export function typedElsewhere(target, surface) {
  if (!(target instanceof Element)) return false
  if (surface?.contains(target)) return false
  if (target.isContentEditable) return true
  return target.matches('input, textarea, select')
}
