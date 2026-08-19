import { describe, expect, it } from 'vitest'
import { Binary } from 'mongodb'
import { toUint8 } from '../src/utils/binary.js'

describe('binary normalisation', () => {
  const bytes = [1, 2, 3, 4, 5]

  it('passes a Buffer through intact', () => {
    expect(Array.from(toUint8(Buffer.from(bytes)))).toEqual(bytes)
  })

  it('unwraps a BSON Binary from a lean query', () => {
    expect(Array.from(toUint8(new Binary(Buffer.from(bytes))))).toEqual(bytes)
  })

  it('is the reason lean() results cannot be passed to Uint8Array directly', () => {
    // Documents the trap: this silently yields an empty array instead of throwing.
    expect(Array.from(new Uint8Array(new Binary(Buffer.from(bytes))))).toEqual([])
  })

  it('returns null for empty input', () => {
    expect(toUint8(null)).toBeNull()
    expect(toUint8(undefined)).toBeNull()
  })
})
