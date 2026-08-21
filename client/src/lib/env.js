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
