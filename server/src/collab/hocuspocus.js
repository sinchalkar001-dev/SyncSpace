import { Hocuspocus } from '@hocuspocus/server'
import { MongoPersistence } from './persistence.js'
import { authenticate } from '../services/auth.service.js'
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
      const { user, revoked } = await authenticate(token)
      const room = await ensureRoom(documentName)

      /**
       * A session that ended is refused outright rather than quietly demoted
       * to a guest. Both would stop the edits counting as that account, but
       * silently becoming "Guest" in a room you were named in is the kind of
       * thing people notice ten minutes later; being told to sign in again is
       * something they can act on.
       */
      if (revoked) throw refuse('Your session ended — sign in again to rejoin this room')

      if (!user) {
        if (!env.ALLOW_ANONYMOUS) throw refuse('Sign in to open this room')
        if (!room.isPublic) throw refuse('This room is private — ask its owner for an invite')
        return { user: { id: null, name: 'Guest', anonymous: true } }
      }

      if (room.isBlocked(user.id)) {
        throw refuse('You were removed from this room by its owner')
      }

      if (!canAccess(room, user.id)) {
        throw refuse('This room is private and you are not on its guest list')
      }

      /**
       * The session id travels with the connection so signing out one device
       * can find and close exactly its connections, rather than every one the
       * account has open. It sits beside the user rather than inside it, so
       * that anything which forwards the identity cannot carry it along.
       */
      return {
        user: { id: user.id, name: user.name, anonymous: false },
        sessionId: user.sessionId,
      }
    },

    async onConnect({ documentName }) {
      logger.debug({ room: documentName }, 'collab connection opened')
    },
  })
}
