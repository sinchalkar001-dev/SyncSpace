import { Hocuspocus } from '@hocuspocus/server'
import { MongoPersistence } from './persistence.js'
import { watchDocument } from './document-activity.js'
import { authenticate } from '../services/auth.service.js'
import { ensureRoom } from '../services/room.service.js'
import { CAPABILITIES, can, roleFor } from '../permissions.js'
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
 * Marks the connection read-only unless this person may change the document.
 *
 * This is the enforcement that matters most in the whole permission system.
 * Every REST guard in the codebase could be perfect and a viewer would still
 * be able to rewrite the room, because the whiteboard and the code buffer do
 * not travel over REST at all — they are Yjs updates on this socket. Hiding
 * the toolbar in the client is decoration; this is the part that says no.
 *
 * Hocuspocus enforces it by dropping incoming updates from a read-only
 * connection rather than by closing it, which is the behaviour worth having:
 * a viewer stays connected, keeps receiving everybody else's edits, and simply
 * cannot contribute any.
 *
 * One limitation, stated because it is invisible otherwise: the whiteboard and
 * the code buffer share a single Yjs document, so there is one flag for both.
 * A role that could draw but not type could not be enforced here without
 * splitting the document. No current role needs that — every role that can
 * edit one can edit the other — but a future one would have to.
 */
function applyWriteAccess(connection, room, userId) {
  const mayWrite =
    can(room, userId, CAPABILITIES.CODE_EDIT) || can(room, userId, CAPABILITIES.WHITEBOARD_EDIT)

  if (connection && !mayWrite) connection.readOnly = true
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
    async onAuthenticate({ token, documentName, connection }) {
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

        applyWriteAccess(connection, room, null)
        return { user: { id: null, name: 'Guest', anonymous: true }, role: roleFor(room, null) }
      }

      if (room.isBlocked(user.id)) {
        throw refuse('You were removed from this room by its owner')
      }

      if (!can(room, user.id, CAPABILITIES.ROOM_VIEW)) {
        throw refuse('This room is private and you are not on its guest list')
      }

      applyWriteAccess(connection, room, user.id)

      /**
       * The session id travels with the connection so signing out one device
       * can find and close exactly its connections, rather than every one the
       * account has open. It sits beside the user rather than inside it, so
       * that anything which forwards the identity cannot carry it along.
       */
      return {
        user: { id: user.id, name: user.name, anonymous: false },
        role: roleFor(room, user.id),
        sessionId: user.sessionId,
      }
    },

    /**
     * Runs once the snapshot and the update log have been applied, which is
     * the only safe moment to start listening: a document loading replays its
     * whole history into itself, and a listener attached any earlier would
     * report all of it as work somebody had just done.
     */
    async afterLoadDocument({ documentName, document }) {
      watchDocument(documentName, document)
    },

    async onConnect({ documentName }) {
      logger.debug({ room: documentName }, 'collab connection opened')
    },
  })
}
