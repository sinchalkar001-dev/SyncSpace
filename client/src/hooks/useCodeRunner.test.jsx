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

/**
 * A run has a name before it has a result.
 *
 * That is the whole reason `execution:state` exists: until the room is told
 * the id of something still running, there is nothing a Cancel button can
 * address, and the only way out of a slow program is the timeout.
 */
describe('a run still in flight', () => {
  const running = (over = {}) => ({
    executionId: 'exec-1',
    runId: null,
    state: 'running',
    by: { id: null, name: 'Priya' },
    ...over,
  })

  it('shows what the room is running, including somebody else’s', () => {
    const { result: hook } = renderHook(() => useCodeRunner('room-1'))

    act(() => hook.current.receiveState(running()))

    expect(hook.current.live.executionId).toBe('exec-1')
    expect(hook.current.live.state).toBe('running')
    expect(hook.current.live.mine).toBe(false)
  })

  it('clears when the run reaches a state it cannot leave', () => {
    const { result: hook } = renderHook(() => useCodeRunner('room-1'))

    act(() => hook.current.receiveState(running()))
    act(() => hook.current.receiveState(running({ state: 'completed' })))

    expect(hook.current.live).toBeNull()
  })

  /** A late message about an old run must not blank the current one. */
  it('ignores a finished message for a run that is not the live one', () => {
    const { result: hook } = renderHook(() => useCodeRunner('room-1'))

    act(() => hook.current.receiveState(running({ executionId: 'current' })))
    act(() => hook.current.receiveState(running({ executionId: 'older', state: 'completed' })))

    expect(hook.current.live?.executionId).toBe('current')
  })

  it('stops it by the id the room was given', async () => {
    const cancel = vi.spyOn(api, 'cancelRun').mockResolvedValue({ cancelled: true, state: 'cancelled' })

    const { result: hook } = renderHook(() => useCodeRunner('room-1'))
    act(() => hook.current.receiveState(running()))

    await act(() => hook.current.cancel())

    expect(cancel).toHaveBeenCalledWith('room-1', 'exec-1', undefined)
  })

  /**
   * A guest has no account, so the name they run under is the only thing that
   * says the program is theirs to stop. Omitting it made a guest a stranger to
   * their own run: the server refused, and the program went on to its timeout.
   */
  it('says who it is, so a guest can stop their own program', async () => {
    const cancel = vi.spyOn(api, 'cancelRun').mockResolvedValue({ cancelled: true, state: 'cancelled' })

    const { result: hook } = renderHook(() => useCodeRunner('room-1', 'Guest-Qn2F'))
    act(() => hook.current.receiveState(running()))

    await act(() => hook.current.cancel())

    expect(cancel).toHaveBeenCalledWith('room-1', 'exec-1', 'Guest-Qn2F')
  })

  it('does nothing when there is nothing running', async () => {
    const cancel = vi.spyOn(api, 'cancelRun').mockResolvedValue({})

    const { result: hook } = renderHook(() => useCodeRunner('room-1'))
    await act(() => hook.current.cancel())

    expect(cancel).not.toHaveBeenCalled()
  })

  /**
   * Losing the race with a program that was about to finish anyway is not
   * worth an error toast.
   */
  it('stays quiet when the run has already gone', async () => {
    const gone = Object.assign(new Error('No such execution'), { code: 'execution_not_found' })
    vi.spyOn(api, 'cancelRun').mockRejectedValue(gone)

    const { result: hook } = renderHook(() => useCodeRunner('room-1'))
    act(() => hook.current.receiveState(running()))

    await act(() => hook.current.cancel())

    expect(hook.current.error).toBeNull()
    expect(hook.current.cancelling).toBe(false)
  })

  /**
   * But a real refusal has to be visible. Swallowing everything is what let a
   * guest press a Cancel button that silently did nothing at all.
   */
  it('shows a refusal rather than swallowing it', async () => {
    const refused = Object.assign(new Error('You can only stop a program you started'), {
      code: 'execution_forbidden',
    })
    vi.spyOn(api, 'cancelRun').mockRejectedValue(refused)

    const { result: hook } = renderHook(() => useCodeRunner('room-1'))
    act(() => hook.current.receiveState(running()))

    await act(() => hook.current.cancel())

    expect(hook.current.error).toBe('You can only stop a program you started')
  })
})

describe('what the server admits about isolation', () => {
  it('passes the report through for the console to warn about', async () => {
    vi.spyOn(api, 'runners').mockResolvedValue({
      ...SUPPORT,
      isolation: { backend: 'process', weak: true, unenforced: ['network', 'filesystem'] },
    })

    const { result: hook } = renderHook(() => useCodeRunner('room-1'))
    await waitFor(() => expect(hook.current.support).toBeTruthy())

    expect(hook.current.isolation.weak).toBe(true)
    expect(hook.current.isolation.unenforced).toContain('network')
  })

  it('is null rather than guessing when the server says nothing', async () => {
    const { result: hook } = renderHook(() => useCodeRunner('room-1'))
    await waitFor(() => expect(hook.current.support).toBeTruthy())

    expect(hook.current.isolation).toBeNull()
  })
})
