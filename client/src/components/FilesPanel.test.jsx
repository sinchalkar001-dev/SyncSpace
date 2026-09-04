import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FilesPanel } from './FilesPanel.jsx'
import { ToastProvider } from './ui/ToastProvider.jsx'
import { setAuthToken } from '../api/client.js'
import { formatSize, rejectionFor } from '../lib/files.js'

/**
 * Sharing files in a room. The backend has had upload, list, download and
 * delete since it was written and nothing in the app ever called any of it.
 */

const ME = { id: 'u1', name: 'Ada' }

const MINE = {
  id: 'f1',
  roomId: 'MSTTPQuJ',
  userId: 'u1',
  originalName: 'wireframe.png',
  mimeType: 'image/png',
  size: 204800,
  createdAt: new Date().toISOString(),
}

const THEIRS = {
  id: 'f2',
  roomId: 'MSTTPQuJ',
  userId: 'u2',
  originalName: 'spec.pdf',
  mimeType: 'application/pdf',
  size: 1048576,
  createdAt: new Date().toISOString(),
}

const ok = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) })

let calls

function mockApi({ files = [MINE, THEIRS], fails, blob } = {}) {
  calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    const method = init.method || 'GET'
    const path = String(url)
    calls.push({ method, path, body: init.body })

    if (fails && method !== 'GET') {
      return Promise.resolve({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({ error: { code: 'file_too_large', message: 'File exceeds the limit' } }),
      })
    }

    if (path.includes('/download')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(blob ?? new Blob(['bytes'])),
      })
    }

    if (method === 'POST') return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ file: MINE }) })
    if (method === 'DELETE') return Promise.resolve(ok({ deleted: true }))

    return Promise.resolve(ok({ files, total: files.length, limit: 50, offset: 0 }))
  })
}

const renderPanel = ({ canUse = true, user = ME } = {}) =>
  render(
    <ToastProvider>
      <FilesPanel roomId="MSTTPQuJ" user={user} canUse={canUse} />
    </ToastProvider>
  )

/**
 * userEvent applies the input's `accept` attribute before dispatching change,
 * exactly as a file picker would. That filter is the browser's, not ours — so
 * it is switched off here to reach the panel's own validation.
 */
const pick = (input, file) => userEvent.upload(input, file, { applyAccept: false })

const openPanel = async () => {
  await userEvent.click(screen.getByRole('button', { name: /^Files/ }))
  return screen.getByRole('dialog', { name: 'Room files' })
}

beforeEach(() => {
  setAuthToken('token-1')
  mockApi()
})

describe('FilesPanel', () => {
  it('lists what the room has, with size and age', async () => {
    renderPanel()
    const panel = await openPanel()

    expect(await within(panel).findByText('wireframe.png')).toBeInTheDocument()
    expect(within(panel).getByText('spec.pdf')).toBeInTheDocument()
    expect(within(panel).getByText(/200 KB/)).toBeInTheDocument()
    expect(within(panel).getByText(/1 MB/)).toBeInTheDocument()
  })

  it('reads nothing until it is opened', () => {
    renderPanel()
    expect(calls).toHaveLength(0)
  })

  it('says how many files there are before it is opened', async () => {
    renderPanel()
    await openPanel()
    await screen.findByText('wireframe.png')

    expect(screen.getByRole('button', { name: 'Files (2)' })).toBeInTheDocument()
  })

  /**
   * Deleting is the uploader's or the room owner's to do, and the server
   * enforces it — offering it to anyone else is a button that only ever fails.
   */
  it('offers Remove only on your own files', async () => {
    renderPanel()
    const panel = await openPanel()
    await within(panel).findByText('wireframe.png')

    const mine = within(panel).getByText('wireframe.png').closest('li')
    const theirs = within(panel).getByText('spec.pdf').closest('li')

    expect(within(mine).getByRole('button', { name: 'Remove' })).toBeInTheDocument()
    expect(within(theirs).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()

    // Saving, though, is for everyone in the room.
    expect(within(theirs).getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('uploads the chosen file as multipart, not as JSON', async () => {
    renderPanel()
    const panel = await openPanel()
    await within(panel).findByText('wireframe.png')

    const file = new File(['x'], 'notes.txt', { type: 'text/plain' })
    await pick(within(panel).getByLabelText('Choose a file to share'), file)

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    const post = calls.find((c) => c.method === 'POST')

    // A FormData body, and the field name the server reads.
    expect(post.body).toBeInstanceOf(FormData)
    expect(post.body.get('file')).toBe(file)
  })

  it('re-reads the list after an upload rather than inventing a row', async () => {
    renderPanel()
    const panel = await openPanel()
    await within(panel).findByText('wireframe.png')

    const before = calls.filter((c) => c.method === 'GET').length
    await pick(within(panel).getByLabelText('Choose a file to share'), new File(['x'], 'notes.txt', { type: 'text/plain' })
    )

    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(before)
    )
  })

  /** Refused here so ten megabytes are not pushed up the wire to be refused there. */
  it('refuses a file the server would reject, without uploading it', async () => {
    renderPanel()
    const panel = await openPanel()
    await within(panel).findByText('wireframe.png')

    const huge = new File(['x'], 'video.mp4', { type: 'video/mp4' })
    await pick(within(panel).getByLabelText('Choose a file to share'), huge)

    expect(await within(panel).findByText(/cannot be shared/)).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('downloads through an authenticated request, not a bare link', async () => {
    const createObjectURL = vi.fn(() => 'blob:fake')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })

    renderPanel()
    const panel = await openPanel()
    await within(panel).findByText('spec.pdf')

    const theirs = within(panel).getByText('spec.pdf').closest('li')
    await userEvent.click(within(theirs).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(calls.some((c) => c.path.includes('/download'))).toBe(true))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())

    vi.unstubAllGlobals()
  })

  it('removes a file and re-reads the list', async () => {
    renderPanel()
    const panel = await openPanel()
    await within(panel).findByText('wireframe.png')

    const mine = within(panel).getByText('wireframe.png').closest('li')
    await userEvent.click(within(mine).getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/files/f1'))
      ).toBe(true)
    )
  })

  it('says what to do when there is nothing shared yet', async () => {
    mockApi({ files: [] })
    renderPanel()
    const panel = await openPanel()

    expect(await within(panel).findByText(/Nothing shared yet/)).toBeInTheDocument()
  })

  it('tells a guest why they cannot share, instead of failing', async () => {
    renderPanel({ canUse: false, user: null })
    const panel = await openPanel()

    expect(within(panel).getByText(/needs an account/)).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Share a file' })).not.toBeInTheDocument()
    // And asks the server nothing, since every route would refuse it.
    expect(calls).toHaveLength(0)
  })

  it('reports a refused upload rather than swallowing it', async () => {
    mockApi({ fails: true })
    renderPanel()
    const panel = await openPanel()
    await within(panel).findByText('wireframe.png')

    await pick(within(panel).getByLabelText('Choose a file to share'), new File(['x'], 'notes.txt', { type: 'text/plain' })
    )

    expect(await screen.findByText('File exceeds the limit')).toBeInTheDocument()
  })
})

describe('file helpers', () => {
  it('reads sizes the way a person does', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(999)).toBe('999 B')
    expect(formatSize(1024)).toBe('1 KB')
    expect(formatSize(204800)).toBe('200 KB')
    expect(formatSize(1048576)).toBe('1 MB')
    expect(formatSize(1572864)).toBe('1.5 MB')
    expect(formatSize(undefined)).toBe('')
  })

  it('names the file and its actual size when it is too big', () => {
    const why = rejectionFor({ name: 'huge.png', type: 'image/png', size: 11 * 1024 * 1024 })
    expect(why).toContain('huge.png')
    expect(why).toContain('11 MB')
    expect(why).toContain('10 MB')
  })

  it('accepts what the server accepts', () => {
    expect(rejectionFor({ name: 'a.png', type: 'image/png', size: 10 })).toBeNull()
    expect(rejectionFor({ name: 'a.pdf', type: 'application/pdf', size: 10 })).toBeNull()
    expect(rejectionFor({ name: 'a.txt', type: 'text/plain', size: 10 })).toBeNull()
    // Charset parameters are part of a real Content-Type and must not confuse it.
    expect(rejectionFor({ name: 'a.csv', type: 'text/csv; charset=utf-8', size: 10 })).toBeNull()
  })

  it('refuses what the server refuses', () => {
    expect(rejectionFor({ name: 'a.mp4', type: 'video/mp4', size: 10 })).toMatch(/video\/mp4/)
    expect(rejectionFor({ name: 'a.zip', type: 'application/zip', size: 10 })).toMatch(/cannot be shared/)
    expect(rejectionFor({ name: 'a.bin', type: '', size: 10 })).toMatch(/That kind of file/)
  })
})
