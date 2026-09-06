import { describe, expect, it } from 'vitest'
import { scanText } from './scan-secrets.js'

/**
 * The guard that keeps a credential out of the repository.
 *
 * Two failure modes, and they pull against each other. Missing a real key is
 * the obvious one. Crying wolf is the quieter one and ends the same way: a
 * scanner that fires on ordinary code gets switched off, and then it is not a
 * scanner. Roughly half of what follows is about the second.
 *
 * Every fixture below is assembled from pieces rather than written out, so
 * that this file contains no string that looks like a key — otherwise the
 * scanner would have to skip its own tests, and a rule with a hole in it is
 * the kind that lets the real thing through.
 */

const googleKey = 'AIza' + 'Sy' + 'B'.repeat(33)
/** What AI Studio issues now — a different shape, and easy to miss. */
const googleKeyNew = 'AQ.' + 'Ab8' + 'C'.repeat(45)
const anthropicKey = 'sk-' + 'ant-' + 'api03-' + 'x'.repeat(40)
const awsKey = 'AKIA' + 'B'.repeat(16)
const githubToken = 'ghp_' + 'a'.repeat(36)

describe('finds a real credential', () => {
  /** The one that prompted all this. */
  it('catches a Google API key', () => {
    const found = scanText('server/config.js', 'const key = "' + googleKey + '"')

    expect(found).toHaveLength(1)
    expect(found[0].what).toMatch(/google/i)
    expect(found[0].line).toBe(1)
  })

  /**
   * A scanner that only knows last year's format is the kind that lets the
   * current one through — and the current one is what a rotation produces.
   */
  it('catches the newer Google key format too', () => {
    const found = scanText('server/config.js', 'const key = "' + googleKeyNew + '"')

    expect(found).toHaveLength(1)
    expect(found[0].what).toMatch(/google/i)
  })

  it('catches the other formats worth knowing by sight', () => {
    expect(scanText('a.js', 'x = "' + anthropicKey + '"')[0].what).toMatch(/anthropic/i)
    expect(scanText('a.js', 'x = "' + awsKey + '"')[0].what).toMatch(/aws/i)
    expect(scanText('a.js', 'x = "' + githubToken + '"')[0].what).toMatch(/github/i)
    expect(scanText('a.pem', '-----BEGIN RSA PRIVATE KEY-----')[0].what).toMatch(/private key/i)
  })

  /**
   * A key in a comment is still a key. Documentation is exactly where one
   * gets pasted "just to show the format", and the format is not the part
   * that matters.
   */
  it('catches one hiding in a comment or a document', () => {
    expect(scanText('README.md', 'Set it like `' + googleKey + '`')).toHaveLength(1)
    expect(scanText('a.js', '// example: ' + googleKey)).toHaveLength(1)
  })

  it('reports the line it is on', () => {
    const found = scanText('a.js', ['one', 'two', 'k = "' + googleKey + '"'].join('\n'))
    expect(found[0].line).toBe(3)
  })

  it('reads a file with Windows line endings the same way', () => {
    const found = scanText('a.js', 'one\r\ntwo\r\nk = "' + googleKey + '"\r\n')
    expect(found[0].line).toBe(3)
  })
})

describe('does not cry wolf', () => {
  /** If this fires on ordinary code, the hook gets bypassed and stays bypassed. */
  it('says nothing about code that merely mentions keys', () => {
    const source = [
      "const apiKey = process.env.ANTHROPIC_API_KEY",
      "headers['x-api-key'] = key",
      "if (!key) throw new Error('no API key configured')",
      "const SECRET = config.secret",
      "password: z.string().min(8).max(200),",
    ].join('\n')

    expect(scanText('server/src/services/ai.service.js', source)).toEqual([])
  })

  it('says nothing about a committed example file full of placeholders', () => {
    const source = [
      '# ANTHROPIC_API_KEY=sk-ant-...',
      'SMTP_HOST=smtp.gmail.com',
      'SMTP_PORT=587',
      'SMTP_USER=your.address@gmail.com',
      'SMTP_PASS=abcd efgh ijkl mnop',
      '# JWT_SECRET=',
      '# AI_MODEL=',
    ].join('\n')

    expect(scanText('server/.env.example', source)).toEqual([])
  })

  it('says nothing about ports, booleans and names', () => {
    const source = ['PORT=4000', 'AI_ENABLED=true', 'AI_MODEL=gemini-3.6-flash'].join('\n')
    expect(scanText('server/.env.example', source)).toEqual([])
  })

  /**
   * But an example file with a *real* value in it is the worst case of all:
   * it is committed by design, so nobody looks at it twice.
   */
  it('still catches a real value pasted into the example file', () => {
    const found = scanText('server/.env.example', 'GOOGLE_API_KEY=' + googleKey)

    expect(found).toHaveLength(1)
    expect(found[0].what).toMatch(/google/i)
  })

  it('catches a long opaque value assigned to a credential name there', () => {
    const found = scanText('server/.env.example', 'JWT_SECRET=' + 'q7Zt'.repeat(9))

    expect(found).toHaveLength(1)
    expect(found[0].what).toMatch(/JWT_SECRET/)
  })
})

describe('the escape hatch', () => {
  it('honours a marker on the same line', () => {
    const line = 'KEY = "' + googleKey + '" // secret-scan: allow'
    expect(scanText('a.js', line)).toEqual([])
  })

  /** A reason worth writing rarely fits on the end of the line it excuses. */
  it('honours a marker on the line directly above', () => {
    const source = ['// secret-scan: allow — a fixture', 'KEY = "' + googleKey + '"'].join('\n')
    expect(scanText('a.js', source)).toEqual([])
  })

  /** One line, like eslint-disable-next-line. Two would be a hole. */
  it('does not reach back further than one line', () => {
    const source = [
      '// secret-scan: allow',
      '// something else entirely',
      'KEY = "' + googleKey + '"',
    ].join('\n')

    expect(scanText('a.js', source)).toHaveLength(1)
  })
})
