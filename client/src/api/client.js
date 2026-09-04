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
 * Turns a failed response into an ApiError, for the two paths below that
 * cannot go through apiFetch. Same translation, same expiry handling.
 */
async function refusal(response) {
  const payload = await response.json().catch(() => null)
  if (response.status === 401 && authToken) expiredHandler?.()
  const { code, message } = describeFailure(response.status, payload)
  return new ApiError(response.status, code, message)
}

/**
 * One request with the bearer token attached and a failure translated exactly
 * as apiFetch translates one, answering the raw Response.
 *
 * The three callers below all need the same auth and the same error handling
 * but read the body in three different shapes — JSON, a Blob, raw bytes — and
 * none of them can go through apiFetch, which assumes JSON in both directions.
 */
async function authedFetch(path, { method = 'GET', headers = {}, body, signal } = {}) {
  const sent = { ...headers }
  if (authToken) sent.Authorization = 'Bearer ' + authToken

  let response
  try {
    response = await fetch(API_URL + path, { method, headers: sent, signal, body })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    throw new ApiError(0, 'network_error', UNREACHABLE)
  }

  if (!response.ok) throw await refusal(response)
  return response
}

/**
 * Sends a multipart body.
 *
 * Deliberately not apiFetch: that stamps Content-Type: application/json on
 * anything with a body and JSON.stringifies it, which would turn a FormData
 * into the string "[object FormData]". Multipart also needs a boundary in the
 * header, and only the browser can generate one to match the body it encodes —
 * so Content-Type is left unset here on purpose.
 */
export async function apiUpload(path, formData, { signal } = {}) {
  const response = await authedFetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: formData,
    signal,
  })
  return response.json()
}

/**
 * Fetches a file's bytes as a Blob.
 *
 * The download route is behind requireAuth, so a plain <a href> would arrive
 * without a bearer token and be refused. The bytes have to be fetched with the
 * header attached and handed to the browser from memory instead.
 */
export async function apiDownload(path, { signal } = {}) {
  const response = await authedFetch(path, { signal })
  return response.blob()
}

/**
 * Fetches raw bytes, for a body that is neither JSON nor a file to save.
 *
 * Replay answers a Yjs update stream, which goes straight into Y.applyUpdate
 * as a Uint8Array — routing it through a Blob first would only add a copy.
 */
export async function apiBytes(path, { signal } = {}) {
  const response = await authedFetch(path, { signal })
  return new Uint8Array(await response.arrayBuffer())
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

  /** Spends the token from a confirmation email. Single-use, so never retried. */
  verifyEmail: (token) => apiFetch('/auth/verify-email', { method: 'POST', body: { token } }),

  /** Issues a fresh confirmation email for the signed-in account. */
  resendVerification: () => apiFetch('/auth/resend-verification', { method: 'POST' }),
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

  /** Everything shared in a room, newest first. Answers { files, total, limit, offset }. */
  listFiles: (roomId, { limit = 50, offset = 0 } = {}, signal) =>
    apiFetch(
      '/rooms/' + encodeURIComponent(roomId) + '/files?limit=' + limit + '&offset=' + offset,
      { signal }
    ),

  /** Shares one file with the room. The field name the server reads is "file". */
  uploadFile: (roomId, file, signal) => {
    const body = new FormData()
    body.append('file', file)
    return apiUpload('/rooms/' + encodeURIComponent(roomId) + '/files', body, { signal })
  },

  /** The file's bytes, as a Blob. */
  downloadFile: (roomId, fileId, signal) =>
    apiDownload(
      '/rooms/' + encodeURIComponent(roomId) + '/files/' + encodeURIComponent(fileId) + '/download',
      { signal }
    ),

  /** Removes a file. The uploader or the room owner, nobody else. */
  deleteFile: (roomId, fileId) =>
    apiFetch(
      '/rooms/' + encodeURIComponent(roomId) + '/files/' + encodeURIComponent(fileId),
      { method: 'DELETE' }
    ),

  /**
   * One page of the room's update log: metadata only, oldest first. `from` is
   * an exclusive lower bound on seq, so paging is last-seq-of-the-last-page.
   */
  replayTimeline: (roomId, { limit = 500, from = 0 } = {}, signal) =>
    apiFetch(
      '/rooms/' + encodeURIComponent(roomId) + '/replay?limit=' + limit + '&from=' + from,
      { signal }
    ),

  /** The document exactly as it stood at `seq`, as a Yjs update stream. */
  replayStateAt: (roomId, seq, signal) =>
    apiBytes('/rooms/' + encodeURIComponent(roomId) + '/replay/' + encodeURIComponent(seq), {
      signal,
    }),
}
