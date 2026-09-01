import { Hocuspocus } from '@hocuspocus/server'
import { MongoPersistence } from './persistence.js'
import { verifyToken } from '../services/auth.service.js'
import { canAccess, ensureRoom } from '../services/room.service.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

/**
 * Refuses a connection with a sentence worth showing.
 *
 * Hocuspocus sends `error.reason` to the client and falls back to the literal
 * string "permission-denied" when there is none — which is what the room gate
 * used to print at anyone who opened a private room.
 */
function refuse(reason) {
  const error = new Error(reason)
  error.reason = reason
  return error
}

/**
 * The Yjs sync server. A fresh instance is constructed per process (rather
 * than the exported `Server` singleton) so tests can run isolated servers.
 */
export function createHocuspocus() {
  return new Hocuspocus({
    name: 'syncspace',
    quiet: true,
    debounce: env.PERSIST_DEBOUNCE_MS,
    maxDebounce: env.PERSIST_MAX_DEBOUNCE_MS,
    extensions: [new MongoPersistence()],

    /**
     * Throwing here rejects the connection and the client receives
     * `authenticationFailed`. The document name is the room id.
     */
    async onAuthenticate({ token, documentName }) {
      const payload = verifyToken(token)
      const room = await ensureRoom(documentName)

      if (!payload) {
        if (!env.ALLOW_ANONYMOUS) throw refuse('Sign in to open this room')
        if (!room.isPublic) throw refuse('This room is private — ask its owner for an invite')
        return { user: { id: null, name: 'Guest', anonymous: true } }
      }

      if (room.isBlocked(payload.sub)) {
        throw refuse('You were removed from this room by its owner')
      }

      if (!canAccess(room, payload.sub)) {
        throw refuse('This room is private and you are not on its guest list')
      }

      return { user: { id: payload.sub, name: payload.name, anonymous: false } }
    },

    async onConnect({ documentName }) {
      logger.debug({ room: documentName }, 'collab connection opened')
    },
  })
}
