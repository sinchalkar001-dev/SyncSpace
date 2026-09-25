// Central place for the three backend endpoints.
// In dev these stay relative so vite.config.js proxies them to the backend.
const origin = import.meta.env.VITE_BACKEND_ORIGIN || ''

function wsFrom(httpUrl, path) {
  if (!httpUrl) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}${path}`
  }
  return httpUrl.replace(/^http/, 'ws') + path
}

export const API_URL = import.meta.env.VITE_API_URL || `${origin}/api/v1`
export const COLLAB_URL = import.meta.env.VITE_COLLAB_URL || wsFrom(origin, '/collab')
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || origin || window.location.origin

/**
 * Said once, where whoever deployed it will look.
 *
 * Relative addresses work in development because vite.config.js proxies them.
 * A built client has no proxy: with no origin configured it asks the host
 * serving the page, which answers with the page — so every request fails in a
 * way that names the API rather than the setting that is missing.
 */
if (import.meta.env.PROD && !origin && !import.meta.env.VITE_API_URL) {
  console.error(
    'SyncSpace was built without VITE_BACKEND_ORIGIN, so it is asking ' +
      window.location.origin +
      ' for the API. Set VITE_BACKEND_ORIGIN to the API’s address and build again.'
  )
}
