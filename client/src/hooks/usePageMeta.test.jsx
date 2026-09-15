import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { usePageMeta } from './usePageMeta.js'

function Page(props) {
  usePageMeta(props)
  return null
}

const visit = (path, props = {}) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Page {...props} />
    </MemoryRouter>
  )

const meta = (name) => document.head.querySelector('meta[name="' + name + '"]')?.getAttribute('content')
const canonical = () => document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')

describe('usePageMeta', () => {
  it('names the page in its title', () => {
    visit('/login', { title: 'Sign in' })
    expect(document.title).toBe('Sign in · SyncSpace')
  })

  it('carries a description of its own', () => {
    visit('/register', { title: 'Create an account', description: 'Keep your rooms.' })
    expect(meta('description')).toBe('Keep your rooms.')
  })

  it('lets a public page be listed, at an address without its query string', () => {
    visit('/register?ref=newsletter', { title: 'Create an account' })
    expect(meta('robots')).toBe('index, follow')
    expect(canonical()).toBe(window.location.origin + '/register')
  })

  /** A room code in a search result is somebody's room, open to anyone. */
  it('keeps a room out of search results, dropping the canonical a public page left', () => {
    const { unmount } = visit('/login', { title: 'Sign in' })
    expect(canonical()).toBeDefined()
    unmount()

    visit('/room/abc123', { title: 'Sprint planning' })
    expect(meta('robots')).toBe('noindex, nofollow')
    expect(canonical()).toBeUndefined()
  })

  it('keeps a page out that nobody decided to list', () => {
    visit('/forgot-password', { title: 'Reset your password' })
    expect(meta('robots')).toBe('noindex, nofollow')
  })
})
