import { randomInt } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Small URL-safe id generator; avoids adding nanoid to the server. */
export function nanoid(size = 8) {
  let out = ''
  for (let i = 0; i < size; i += 1) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}
