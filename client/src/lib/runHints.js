/**
 * Turns a failed run into advice, where the failure has an obvious cause.
 *
 * The case worth catching: a program that reads from standard input, run with
 * nothing in the input box. Every language reports it differently and none of
 * them mention the box the person needed to fill, so the stack trace reads as
 * "your code is broken" when the code is fine.
 */

/**
 * Each language's way of saying "I asked for input and there was none".
 *
 * Deliberately narrow. A hint that fires on an unrelated crash is worse than
 * no hint, because it sends someone looking in the wrong place.
 */
const OUT_OF_INPUT = [
  /java\.util\.NoSuchElementException/, // Scanner, nothing left to read
  /\bEOFError\b/, // Python input()
  /EOF when reading a line/,
  /InputMismatchException/, // Scanner given something, but not a number
  /Cannot read properties of null \(reading 'trim'\)/, // readline on a closed stdin
]

/**
 * A short explanation to show above the output, or null when the failure
 * speaks for itself.
 */
export function hintFor(result, stdin) {
  if (!result || result.ok || result.timedOut) return null

  // Somebody else's run, shown in the shared console. Their input box is not
  // this one, so advice about filling it in would be pointing at the wrong
  // screen entirely.
  if (result.by) return null

  const output = (result.stderr || '') + (result.stdout || '')

  if (!stdin.trim() && OUT_OF_INPUT.some((sign) => sign.test(output))) {
    return {
      id: 'needs-input',
      message: 'This program reads input, and the input box was empty.',
      action: 'Add input',
    }
  }

  return null
}
