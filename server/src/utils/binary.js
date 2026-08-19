/**
 * Normalises binary data coming out of MongoDB.
 *
 * A hydrated Mongoose document yields a Node Buffer, but a `.lean()` query
 * yields a BSON `Binary` wrapper. Passing that wrapper straight to
 * `new Uint8Array(...)` silently produces an EMPTY array rather than throwing,
 * which would make persisted documents load as blank. Always go through here.
 */
export function toUint8(value) {
  if (!value) return null
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value.buffer) return new Uint8Array(value.buffer)
  return new Uint8Array(value)
}
