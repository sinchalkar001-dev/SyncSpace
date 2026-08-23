import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch, onAuthExpired, setAuthToken } from './client.js'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }
}

beforeEach(() => {
  setAuthToken(null)
  onAuthExpired(null)
})

describe('apiFetch', () => {
  it('sends no Authorization header when signed out', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }))

    await apiFetch('/rooms')

    const [, init] = fetchSpy.mock.calls[0]
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('attaches the bearer token once set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }))
    setAuthToken('token-123')

    await apiFetch('/rooms')

    const [, init] = fetchSpy.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer token-123')
  })

  it('serialises a body and sets the content type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }))

    await apiFetch('/rooms', { method: 'POST', body: { name: 'Design' } })

    const [, init] = fetchSpy.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ name: 'Design' })
  })

  it('turns an error payload into an ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { code: 'email_taken', message: 'That email is already registered' } }, 409)
    )

    await expect(apiFetch('/auth/register', { method: 'POST', body: {} })).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'email_taken',
      message: 'That email is already registered',
    })
  })

  it('reports an unreachable server rather than leaking the raw failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    const error = await apiFetch('/rooms').catch((cause) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('network_error')
    expect(error.status).toBe(0)
  })

  /**
   * The backend opens its port only once the database is connected, so the
   * first request of a session can arrive before anything is listening. The
   * dev proxy answers that with a status and no JSON, which used to surface as
   * "Something went wrong" on a sign-in that worked perfectly a second later.
   */
  describe('a server that is not up yet', () => {
    it('says so, rather than blaming the request', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      })

      const error = await apiFetch('/rooms').catch((cause) => cause)
      expect(error.code).toBe('server_unreachable')
      expect(error.message).toMatch(/still starting up/i)
    })

    it('names the status for any other answer it cannot read', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 418,
        json: () => Promise.reject(new SyntaxError('not json')),
      })

      const error = await apiFetch('/rooms').catch((cause) => cause)
      expect(error.code).toBe('unexpected_response')
      expect(error.message).toContain('418')
    })

    it('retries a call that never arrived, and returns the answer', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue(jsonResponse({ token: 'welcome' }))

      const payload = await apiFetch('/auth/login', { method: 'POST', retry: 2 })

      expect(payload).toEqual({ token: 'welcome' })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('gives up after its retries and reports the failure', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new TypeError('Failed to fetch'))

      const error = await apiFetch('/auth/login', { method: 'POST', retry: 2 }).catch((c) => c)

      expect(error.code).toBe('network_error')
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    /**
     * A 502 or 504 means something upstream answered — the work may already be
     * done and only the reply lost. Repeating that could create a second room
     * or a second account.
     */
    it('does not repeat a call that may have been carried out', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new SyntaxError('not json')),
      })

      await apiFetch('/auth/register', { method: 'POST', retry: 2 }).catch(() => {})
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('never retries a request the caller aborted', async () => {
      const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort)

      await apiFetch('/auth/me', { retry: 2 }).catch(() => {})
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('notifies the expiry handler when an authenticated request is rejected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { code: 'unauthorized', message: 'nope' } }, 401)
    )
    const expired = vi.fn()
    onAuthExpired(expired)
    setAuthToken('stale-token')

    await apiFetch('/auth/me').catch(() => {})
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('does not treat a failed sign-in as an expired session', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { code: 'bad_credentials', message: 'nope' } }, 401)
    )
    const expired = vi.fn()
    onAuthExpired(expired)

    await apiFetch('/auth/login', { method: 'POST', body: {} }).catch(() => {})
    expect(expired).not.toHaveBeenCalled()
  })

  it('returns null for an empty response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 204 })
    await expect(apiFetch('/rooms/x')).resolves.toBeNull()
  })

  it('rethrows aborts untouched so callers can ignore them', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort)

    await expect(apiFetch('/rooms')).rejects.toThrow('aborted')
  })
})
