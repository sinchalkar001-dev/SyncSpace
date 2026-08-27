import { Hocuspocus } from '@hocuspocus/server'
import { MongoPersistence } from './persistence.js'
import { verifyToken } from '../services/auth.service.js'
import { canAccess, ensureRoom } from '../services/room.service.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

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
        if (!env.ALLOW_ANONYMOUS) throw new Error('Authentication required')
        if (!room.isPublic) throw new Error('This room is private')
        return { user: { id: null, name: 'Guest', anonymous: true } }
      }

      if (!canAccess(room, payload.sub)) {
        throw new Error('You do not have access to this room')
      }

      return { user: { id: payload.sub, name: payload.name, anonymous: false } }
    },

    async onConnect({ documentName }) {
      logger.debug({ room: documentName }, 'collab connection opened')
    },
  })
}
