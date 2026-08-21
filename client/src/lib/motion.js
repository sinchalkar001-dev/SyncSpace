/**
 * Motion preferences, read from the platform rather than guessed.
 *
 * CSS handles most of this through the `prefers-reduced-motion` block in
 * base.css; this is for the cases JavaScript drives, such as counters that
 * animate a number rather than a style.
 */

const QUERY = '(prefers-reduced-motion: reduce)'

/** True when the user has asked the OS to minimise animation. */
export function prefersReducedMotion() {
  // jsdom in the test environment has no matchMedia; treat that as "no motion".
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia(QUERY).matches
}
