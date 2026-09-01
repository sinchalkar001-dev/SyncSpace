import { API_URL } from '../lib/env.js'

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

let authToken = null
let expiredHandler = null

export function setAuthToken(next) {
  authToken = next || null
}

/** Registered by the auth provider so an expired token logs the user out once. */
export function onAuthExpired(handler) {
  expiredHandler = handler
}

const UNREACHABLE =
  'Could not reach the server. If it is restarting, give it a moment and try again.'

/**
 * Turns an error response into something worth reading, and says whether the
 * application ever saw the request.
 *
 * Every failure this API produces is { error: { code, message } }. A 5xx
 * without that envelope did not come from the API at all — the dev proxy
 * answers a backend that is restarting or not yet listening with exactly a
 * 500 and an empty body. Reporting that as "Something went wrong" is how a
 * sign-in with perfectly good credentials looks broken on the first attempt
 * and works on the second.
 */
function describeFailure(status, payload) {
  if (payload?.error?.message) {
    return {
      code: payload.error.code || 'request_failed',
      message: payload.error.message,
      answered: true,
    }
  }

  if (status >= 500) {
    return { code: 'server_unreachable', message: UNREACHABLE, answered: false }
  }

  return {
    code: 'unexpected_response',
    message: 'The server returned an unexpected response (HTTP ' + status + ').',
    answered: true,
  }
}

const BACKOFF_MS = [400, 900]

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Whether a failed attempt is worth repeating: the connection failed outright,
 * or something other than the application answered.
 *
 * Anything the API itself said is final and is never repeated — a rejected
 * password does not become right on a second try.
 */
const REPEATABLE = new Set(['network_error', 'server_unreachable'])

const worthRepeating = (error) => error instanceof ApiError && REPEATABLE.has(error.code)

export async function apiFetch(path, { method = 'GET', body, signal, retry = 0 } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (authToken) headers.Authorization = 'Bearer ' + authToken

  /**
   * A restarting backend is a moment, not a verdict. Waiting and asking again
   * is the difference between "sign in twice" and "sign in".
   */
  const again = (failure) => {
    if (retry <= 0 || !worthRepeating(failure)) throw failure
    return wait(BACKOFF_MS[BACKOFF_MS.length - retry] ?? 900).then(() =>
      apiFetch(path, { method, body, signal, retry: retry - 1 })
    )
  }

  let response
  try {
    response = await fetch(API_URL + path, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    return again(new ApiError(0, 'network_error', UNREACHABLE))
  }

  if (response.status === 204) return null

  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    // Only a request that carried a token can have had it expire.
    if (response.status === 401 && authToken) expiredHandler?.()
    const { code, message } = describeFailure(response.status, payload)
    return again(new ApiError(response.status, code, message))
  }

  return payload
}

/**
 * `retry` is set only where repeating the call cannot do anything twice.
 * Signing in and reading your own account are safe; creating a room or running
 * a program are not, and are left to fail loudly.
 */
export const api = {
  register: (body) => apiFetch('/auth/register', { method: 'POST', body, retry: 2 }),
  login: (body) => apiFetch('/auth/login', { method: 'POST', body, retry: 2 }),
  me: (signal) => apiFetch('/auth/me', { signal, retry: 2 }),
  changePassword: (body) => apiFetch('/auth/change-password', { method: 'POST', body }),
  listRooms: (signal) => apiFetch('/rooms', { signal }),
  createRoom: (body) => apiFetch('/rooms', { method: 'POST', body }),
  getRoom: (roomId, signal) => apiFetch('/rooms/' + encodeURIComponent(roomId), { signal }),
  roomPeople: (roomId, signal) =>
    apiFetch('/rooms/' + encodeURIComponent(roomId) + '/people', { signal }),

  /** Grants access. `who` is { email } or { userId }, plus an optional role. */
  invite: (roomId, who) =>
    apiFetch('/rooms/' + encodeURIComponent(roomId) + '/invite', { method: 'POST', body: who }),

  /** Withdraws access and keeps the person out, link or no link. */
  removeMember: (roomId, userId) =>
    apiFetch('/rooms/' + encodeURIComponent(roomId) + '/members/' + encodeURIComponent(userId), {
      method: 'DELETE',
    }),

  /** Withdraws an invitation to an address that never signed up. */
  cancelInvite: (roomId, email) =>
    apiFetch('/rooms/' + encodeURIComponent(roomId) + '/invites/' + encodeURIComponent(email), {
      method: 'DELETE',
    }),

  /** Undoes a removal. */
  unblockMember: (roomId, userId) =>
    apiFetch('/rooms/' + encodeURIComponent(roomId) + '/blocked/' + encodeURIComponent(userId), {
      method: 'DELETE',
    }),
  updateRoom: (roomId, patch) =>
    apiFetch('/rooms/' + encodeURIComponent(roomId), { method: 'PATCH', body: patch }),
  deleteRoom: (roomId) =>
    apiFetch('/rooms/' + encodeURIComponent(roomId), { method: 'DELETE' }),

  /** What this server can run, and whether running is switched on at all. */
  runners: (signal) => apiFetch('/runners', { signal }),

  /** Runs a program and resolves with its output; a crash is a result, not a throw. */
  run: (roomId, body, signal) =>
    apiFetch('/rooms/' + encodeURIComponent(roomId) + '/run', { method: 'POST', body, signal }),
}
