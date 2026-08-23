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

/**
 * Statuses that mean the request never got an answer from the app itself —
 * the dev proxy or a gateway replied instead, usually because the backend was
 * not listening yet.
 */
const GATEWAY = new Set([502, 503, 504])

const UNREACHABLE =
  'Could not reach the server. If it is still starting up, give it a moment and try again.'

/**
 * Turns an error response into something worth reading.
 *
 * The API answers failures as { error: { code, message } }, so anything else
 * did not come from the API: the backend binds its port only after the
 * database connects, and a request sent in that window is answered by the dev
 * proxy with a status and no JSON at all. Reporting that as "Something went
 * wrong" is how a working sign-in looks broken on the first attempt — the
 * second attempt, a second later, succeeds.
 */
function describeFailure(status, payload) {
  if (payload?.error?.message) {
    return { code: payload.error.code || 'request_failed', message: payload.error.message }
  }
  if (GATEWAY.has(status)) {
    return { code: 'server_unreachable', message: UNREACHABLE }
  }
  return {
    code: 'unexpected_response',
    message: 'The server returned an unexpected response (HTTP ' + status + ').',
  }
}

const BACKOFF_MS = [400, 900]

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Whether a failed attempt can simply be repeated.
 *
 * Only when the request provably never reached the application: the socket
 * was refused, or the server answered 503 before routing anything. A 502 or a
 * 504 is not included — the upstream may have done the work and lost only the
 * reply, and repeating that would sign someone up twice.
 */
const neverArrived = (error) =>
  error instanceof ApiError && (error.status === 0 || error.status === 503)

export async function apiFetch(path, { method = 'GET', body, signal, retry = 0 } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (authToken) headers.Authorization = 'Bearer ' + authToken

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
    const failure = new ApiError(0, 'network_error', UNREACHABLE)

    // The backend opens its port only once the database is connected, so the
    // first request of a session can land in that window. Waiting a moment
    // and asking again is the difference between "sign in twice" and "sign in".
    if (retry > 0 && neverArrived(failure)) {
      await wait(BACKOFF_MS[BACKOFF_MS.length - retry] ?? 900)
      return apiFetch(path, { method, body, signal, retry: retry - 1 })
    }
    throw failure
  }

  if (response.status === 204) return null

  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    // Only a request that carried a token can have had it expire.
    if (response.status === 401 && authToken) expiredHandler?.()
    const { code, message } = describeFailure(response.status, payload)
    throw new ApiError(response.status, code, message)
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
