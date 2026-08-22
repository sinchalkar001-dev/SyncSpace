import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCodeRunner } from './useCodeRunner.js'
import { api } from '../api/client.js'

const SUPPORT = {
  enabled: true,
  timeoutMs: 5000,
  languages: [
    { language: 'javascript', available: true, toolchain: 'Node.js', version: 'v22.0.0' },
    { language: 'rust', available: false, toolchain: 'Rust', version: '' },
  ],
}

const result = (over = {}) => ({
  stdout: 'hello\n',
  stderr: '',
  exitCode: 0,
  ok: true,
  stage: 'run',
  durationMs: 12,
  ...over,
})

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'runners').mockResolvedValue(SUPPORT)
})

describe('useCodeRunner', () => {
  it('runs code and keeps the result', async () => {
    vi.spyOn(api, 'run').mockResolvedValue({ run: result() })

    const { result: hook } = renderHook(() => useCodeRunner('room-1'))
    await waitFor(() => expect(hook.current.support).toBeTruthy())

    await act(() => hook.current.start({ language: 'javascript', code: 'console.log(1)' }))

    expect(hook.current.result.stdout).toBe('hello\n')
    expect(hook.current.status).toBe('idle')
    expect(hook.current.error).toBeNull()
  })

  it('surfaces a refusal as a message rather than throwing', async () => {
    vi.spyOn(api, 'run').mockRejectedValue(new Error('Running code is switched off'))

    const { result: hook } = renderHook(() => useCodeRunner('room-1'))
    await act(() => hook.current.start({ language: 'javascript', code: 'x' }))

    expect(hook.current.error).toBe('Running code is switched off')
    expect(hook.current.status).toBe('idle')
  })

  it('shows a run somebody else started', async () => {
    const { result: hook } = renderHook(() => useCodeRunner('room-1'))

    act(() => hook.current.receive({ runId: 'theirs', by: { name: 'Priya' }, run: result() }))

    expect(hook.current.result.by.name).toBe('Priya')
    expect(hook.current.result.stdout).toBe('hello\n')
  })

  it('ignores the broadcast of its own run, which it already has', async () => {
    let sentRunId = null
    vi.spyOn(api, 'run').mockImplementation((roomId, body) => {
      sentRunId = body.runId
      return Promise.resolve({ run: result({ stdout: 'from the response\n' }) })
    })

    const { result: hook } = renderHook(() => useCodeRunner('room-1'))
    await act(() => hook.current.start({ language: 'javascript', code: 'x' }))

    act(() =>
      hook.current.receive({ runId: sentRunId, by: { name: 'Me' }, run: result({ stdout: 'echo\n' }) })
    )

    // Still the response's own result, and not attributed to anyone.
    expect(hook.current.result.stdout).toBe('from the response\n')
    expect(hook.current.result.by).toBeNull()
  })

  it('will not start a second run while one is going', async () => {
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const run = vi.spyOn(api, 'run').mockReturnValue(pending)

    const { result: hook } = renderHook(() => useCodeRunner('room-1'))

    let first
    act(() => {
      first = hook.current.start({ language: 'javascript', code: 'x' })
    })
    expect(hook.current.status).toBe('running')

    await act(async () => {
      await hook.current.start({ language: 'javascript', code: 'x' })
    })
    expect(run).toHaveBeenCalledTimes(1)

    await act(async () => {
      release({ run: result() })
      await first
    })
    expect(hook.current.status).toBe('idle')
  })

  describe('explaining why a language cannot run', () => {
    it('says nothing when it can', async () => {
      const { result: hook } = renderHook(() => useCodeRunner('room-1'))
      await waitFor(() => expect(hook.current.support).toBeTruthy())

      expect(hook.current.blocker('javascript')).toBeNull()
    })

    it('names the missing toolchain', async () => {
      const { result: hook } = renderHook(() => useCodeRunner('room-1'))
      await waitFor(() => expect(hook.current.support).toBeTruthy())

      expect(hook.current.blocker('rust')).toContain('Rust is not installed')
    })

    it('is honest about a language with no runner at all', async () => {
      const { result: hook } = renderHook(() => useCodeRunner('room-1'))
      await waitFor(() => expect(hook.current.support).toBeTruthy())

      expect(hook.current.blocker('markdown')).toContain('not run')
    })

    it('treats a server that will not answer as one that cannot run', async () => {
      vi.spyOn(api, 'runners').mockRejectedValue(new Error('offline'))

      const { result: hook } = renderHook(() => useCodeRunner('room-1'))
      await waitFor(() => expect(hook.current.support).toBeTruthy())

      expect(hook.current.blocker('javascript')).toContain('switched off')
    })
  })
})
