import { describe, expect, it } from 'vitest'
import { validateRegistration as validate } from '../lib/validation.js'

describe('registration validation', () => {
  const valid = { name: 'Alice', email: 'alice@syncspace.test', password: 'a-good-passphrase' }

  it('accepts a complete form', () => {
    expect(validate(valid)).toEqual({})
  })

  it('requires a display name', () => {
    expect(validate({ ...valid, name: '   ' }).name).toMatch(/display name/i)
  })

  it('rejects a name over the server limit', () => {
    expect(validate({ ...valid, name: 'x'.repeat(33) }).name).toMatch(/32/)
  })

  it('rejects a malformed email', () => {
    expect(validate({ ...valid, email: 'alice@' }).email).toBeTruthy()
    expect(validate({ ...valid, email: 'alice.syncspace.test' }).email).toBeTruthy()
  })

  it('mirrors the server password minimum', () => {
    expect(validate({ ...valid, password: 'short' }).password).toMatch(/8 characters/)
    expect(validate({ ...valid, password: '12345678' }).password).toBeUndefined()
  })

  it('reports every problem at once rather than one at a time', () => {
    const errors = validate({ name: '', email: 'nope', password: 'x' })
    expect(Object.keys(errors).sort()).toEqual(['email', 'name', 'password'])
  })
})
