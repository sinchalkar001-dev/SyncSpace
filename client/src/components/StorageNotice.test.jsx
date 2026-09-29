import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { NOTICE_KEY, StorageNotice } from './StorageNotice.jsx'

const renderAt = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <StorageNotice />
    </MemoryRouter>
  )

const notice = () => screen.queryByRole('complementary', { name: 'Cookies and storage' })

beforeEach(() => localStorage.clear())

describe('StorageNotice', () => {
  it('tells a first-time visitor what is stored, and links to the details', () => {
    renderAt('/')
    expect(notice()).toHaveTextContent('sets no cookies')
    expect(screen.getByRole('link', { name: 'Read the privacy notice' })).toHaveAttribute(
      'href',
      '/privacy'
    )
  })

  it('stays closed once it has been read', async () => {
    const { unmount } = renderAt('/')
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(notice()).toBeNull()

    unmount()
    renderAt('/')
    expect(notice()).toBeNull()
    expect(localStorage.getItem(NOTICE_KEY)).toBe('seen')
  })

  it('keeps off the canvas and the pages behind a sign-in', () => {
    renderAt('/room/abc123')
    expect(notice()).toBeNull()
  })
})
