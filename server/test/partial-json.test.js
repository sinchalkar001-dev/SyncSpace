import { describe, expect, it } from 'vitest'
import { createEventStreamParser, partialString } from '../src/utils/partial-json.js'

/**
 * Reading an answer that has not finished arriving.
 *
 * The thing worth testing hardest is what this refuses to emit. The caller
 * streams the difference between calls straight to a browser and cannot take
 * anything back, so a half-decoded escape shown once is shown for good — and
 * the buffer ends mid-escape roughly whenever a fragment boundary lands there,
 * which on a long answer is often.
 */

describe('partialString', () => {
  it('reads a field that has finished arriving', () => {
    expect(partialString('{"answer":"done"}', 'answer')).toEqual({
      found: true,
      value: 'done',
      complete: true,
    })
  })

  it('reads as far as a field has got', () => {
    expect(partialString('{"answer":"half a sent', 'answer')).toEqual({
      found: true,
      value: 'half a sent',
      complete: false,
    })
  })

  /** "Not yet" and "empty" are different answers and must not be confused. */
  it('says nothing was found until the value has actually started', () => {
    expect(partialString('{"ans', 'answer').found).toBe(false)
    expect(partialString('{"answer"', 'answer').found).toBe(false)
    expect(partialString('{"answer":', 'answer').found).toBe(false)
    expect(partialString('{"answer":"', 'answer')).toEqual({
      found: true,
      value: '',
      complete: false,
    })
  })

  it('decodes the escapes a model actually produces', () => {
    const raw = JSON.stringify({ answer: 'line one\nline "two"\tand a \\ backslash' })
    expect(partialString(raw, 'answer').value).toBe('line one\nline "two"\tand a \\ backslash')
  })

  it('decodes a \\u escape', () => {
    expect(partialString('{"answer":"caf\\u00e9"}', 'answer').value).toBe('café')
  })

  /** The reason this is not a regex. */
  it('holds back an escape that has not finished arriving', () => {
    expect(partialString('{"answer":"finished\\', 'answer').value).toBe('finished')
    expect(partialString('{"answer":"finished\\u00', 'answer').value).toBe('finished')
    expect(partialString('{"answer":"finished\\u00e', 'answer').value).toBe('finished')
    expect(partialString('{"answer":"finished\\u00e9', 'answer').value).toBe('finishedé')
  })

  it('never goes backwards as more arrives', () => {
    const whole = JSON.stringify({ answer: 'a "quoted" word, a \\ and a café' })
    let previous = ''

    for (let length = 1; length <= whole.length; length += 1) {
      const { value } = partialString(whole.slice(0, length), 'answer')
      expect(value.startsWith(previous) || previous.startsWith(value)).toBe(true)
      // The only legitimate shrink is none: what has been emitted stands.
      expect(value.length).toBeGreaterThanOrEqual(previous.length)
      previous = value
    }

    expect(previous).toBe('a "quoted" word, a \\ and a café')
  })

  /** A field whose *value* says "answer" is not the field. */
  it('does not mistake a value for the key it names', () => {
    const raw = '{"title":"answer","answer":"the real one"}'
    expect(partialString(raw, 'answer').value).toBe('the real one')
  })

  it('skips over earlier fields to reach the one asked for', () => {
    const raw = JSON.stringify({ summary: 'first', answer: 'second' })
    expect(partialString(raw, 'answer').value).toBe('second')
  })

  it('finds nothing in a field that is not a string', () => {
    expect(partialString('{"answer":[1,2]}', 'answer').found).toBe(false)
    expect(partialString('{"answer":null}', 'answer').found).toBe(false)
  })

  it('survives being handed nothing at all', () => {
    expect(partialString('', 'answer').found).toBe(false)
    expect(partialString(undefined, 'answer').found).toBe(false)
  })
})

describe('createEventStreamParser', () => {
  it('reads one whole frame', () => {
    const parser = createEventStreamParser()
    expect(parser.push('event: delta\ndata: {"text":"hi"}\n\n')).toEqual([
      { event: 'delta', data: '{"text":"hi"}' },
    ])
  })

  /**
   * The reason the parser holds state: a frame split across two reads is the
   * ordinary case, not the edge one.
   */
  it('waits for a frame that arrives in pieces', () => {
    const parser = createEventStreamParser()
    expect(parser.push('event: del')).toEqual([])
    expect(parser.push('ta\ndata: {"text":')).toEqual([])
    expect(parser.push('"hi"}\n\n')).toEqual([{ event: 'delta', data: '{"text":"hi"}' }])
  })

  it('reads several frames out of one chunk', () => {
    const parser = createEventStreamParser()
    const frames = parser.push('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')
    expect(frames).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ])
  })

  it('tolerates carriage returns, which proxies add', () => {
    const parser = createEventStreamParser()
    expect(parser.push('event: delta\r\ndata: {"text":"hi"}\r\n\r\n')).toEqual([
      { event: 'delta', data: '{"text":"hi"}' },
    ])
  })

  it('joins a data field split over several lines, as the spec says', () => {
    const parser = createEventStreamParser()
    expect(parser.push('data: one\ndata: two\n\n')).toEqual([{ event: 'message', data: 'one\ntwo' }])
  })
})
