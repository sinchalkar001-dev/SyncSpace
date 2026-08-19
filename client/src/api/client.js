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

export async function apiFetch(path, { method = 'GET', body, signal } = {}) {
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
    throw new ApiError(0, 'network_error', 'Could not reach the server')
  }

  if (response.status === 204) return null

  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    // Only a request that carried a token can have had it expire.
    if (response.status === 401 && authToken) expiredHandler?.()
    throw new ApiError(
      response.status,
      payload?.error?.code || 'request_failed',
      payload?.error?.message || 'Something went wrong'
    )
  }

  return payload
}

export const api = {
  register: (body) => apiFetch('/auth/register', { method: 'POST', body }),
  login: (body) => apiFetch('/auth/login', { method: 'POST', body }),
  me: (signal) => apiFetch('/auth/me', { signal }),
  listRooms: (signal) => apiFetch('/rooms', { signal }),
  createRoom: (body) => apiFetch('/rooms', { method: 'POST', body }),
  getRoom: (roomId, signal) => apiFetch('/rooms/' + encodeURIComponent(roomId), { signal }),
  roomPeople: (roomId, signal) =>
    apiFetch('/rooms/' + encodeURIComponent(roomId) + '/people', { signal }),
  deleteRoom: (roomId) =>
    apiFetch('/rooms/' + encodeURIComponent(roomId), { method: 'DELETE' }),
}
