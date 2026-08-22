import { env } from './env.js'

// Frozen once at startup: CORS_ORIGIN is not re-read at runtime.
const allowlist = new Set(env.CORS_ORIGIN)

/**
 * The one origin policy for every surface — Express REST, Socket.io and the
 * /collab WebSocket upgrade. Browsers attach an Origin header to every
 * cross-site request including WebSocket handshakes, so a present-but-unlisted
 * origin is refused everywhere. A missing header means a non-browser client
 * (curl, tests, monitoring) that cannot be cross-site hijacked; those pass.
 */
export function isAllowedOrigin(origin) {
  return !origin || allowlist.has(origin)
}
