import { describe, expect, it } from 'vitest'
import { redactPageView } from './analytics.js'

const view = (url) => redactPageView({ type: 'pageview', url })

describe('redactPageView', () => {
  it('counts a room without saying which one', () => {
    expect(view('https://syncspace.example.com/room/Ab3xY9qZ').url).toBe(
      'https://syncspace.example.com/room/[code]'
    )
  })

  it('drops the token an email link carries', () => {
    expect(view('https://syncspace.example.com/reset-password?token=abc123#x').url).toBe(
      'https://syncspace.example.com/reset-password'
    )
    expect(view('https://syncspace.example.com/accept-invitation?token=def456').url).toBe(
      'https://syncspace.example.com/accept-invitation'
    )
  })

  it('leaves an ordinary page as it is', () => {
    expect(view('https://syncspace.example.com/privacy')).toEqual({
      type: 'pageview',
      url: 'https://syncspace.example.com/privacy',
    })
  })

  it('sends nothing it cannot read', () => {
    expect(view('not a url')).toBeNull()
  })
})
