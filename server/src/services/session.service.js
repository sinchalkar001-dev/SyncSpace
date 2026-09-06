import jwt from 'jsonwebtoken'
import { Session } from '../models/Session.js'
import { getHocuspocus } from '../collab/registry.js'
import { getIo } from '../realtime/registry.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { newSessionId } from '../utils/token.js'
import { badRequest, notFound } from '../errors.js'

/**
 * Signed-in devices: opening them, listing them, and closing them.
 *
 * A signed JWT cannot be withdrawn — verifying one is arithmetic, and
 * arithmetic has no opinion about what has happened since. The only way to end
 * one early is to keep a record on this side and check it, and the shape of
 * that record decides what is possible. A single marker on the account can
 * only revoke everything at once; a row per session can also name them, which
 * is what makes "here is what is signed in, sign that one out" possible at all.
 *
 * Revoking is deleting the row. There is no `revoked` flag to forget to filter
 * on, the IP address stops being held the moment the session ends, and the
 * absence of a row is the refusal.
 */

/** Close code 4205, "Reset Connection" — the frame room.service.js uses too. */
const RECONNECT_FRAME = { code: 4205, reason: 'Reset Connection' }

/**
 * How stale `lastSeenAt` is allowed to get.
 *
 * The device list is worth little if every row says the session started but
 * not whether it is still in use. Writing on every authenticated request would
 * be a write per request, so it is refreshed at most this often — and never on
 * the request's own path; see `touch`.
 */
const SEEN_REFRESH_MS = 60_000

/**
 * Opens a session and returns its token.
 *
 * The `jti` is the link: the token carries it, the row is named by it, and
 * `authenticate` follows it back. `expiresAt` mirrors the token's own expiry
 * so a row can never outlive what it stands for, which is also what lets the
 * TTL index clear them out.
 */
export async function startSession(user, { userAgent = null, ip = null } = {}) {
  const jti = newSessionId()
  const token = jwt.sign(
    { sub: user.id ?? String(user._id), name: user.name, jti },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  )

  // Read the expiry back off the token rather than recomputing it, so the two
  // cannot drift apart however JWT_EXPIRES_IN is spelled.
  const { exp } = jwt.decode(token)

  await Session.create({
    user: user._id ?? user.id,
    jti,
    userAgent: userAgent ? String(userAgent).slice(0, 400) : null,
    ip: ip ? String(ip).slice(0, 64) : null,
    lastSeenAt: new Date(),
    expiresAt: new Date(exp * 1000),
  })

  return token
}

/**
 * Records that a session is still in use, at most once a minute.
 *
 * Never awaited. This is bookkeeping for a list somebody reads occasionally,
 * and making every authenticated request wait for a write to serve it would be
 * the wrong trade by a wide margin. A lost refresh costs an out-of-date "last
 * active", which is why the failure is swallowed rather than reported.
 */
function touch(session) {
  const seen = session.lastSeenAt?.getTime?.() ?? 0
  if (Date.now() - seen < SEEN_REFRESH_MS) return

  Session.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } }).catch((error) => {
    logger.debug({ err: error }, 'could not refresh a session last-seen time')
  })
}

/**
 * The live session named by a token's `jti`, or null.
 *
 * Null covers every way a session can be over — revoked, expired, or a token
 * from before sessions were recorded — because to a caller they are the same
 * answer: this is not a session any more.
 */
export async function findSession(jti) {
  if (!jti) return null

  const session = await Session.findOne({ jti })
    .select({ user: 1, lastSeenAt: 1, expiresAt: 1 })
    .lean()

  if (!session) return null

  /**
   * The row outliving its token is possible: the TTL monitor only sweeps
   * every minute or so, and it is not a promise about the exact moment. The
   * token's own expiry is checked before this by `jwt.verify`, so this only
   * catches a row whose clock says it should already be gone.
   */
  if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) return null

  touch(session)
  return session
}

/** Everything currently signed in on this account, newest first. */
export async function listSessions(userId) {
  const sessions = await Session.find({ user: userId, expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 })
    .lean()

  return sessions.map((session) => ({
    id: String(session._id),
    userAgent: session.userAgent,
    ip: session.ip,
    lastSeenAt: session.lastSeenAt,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  }))
}

/**
 * Ends one session belonging to `userId`.
 *
 * Scoped to the owner in the query itself rather than checked afterwards, so
 * there is no arrangement of ids that ends somebody else's session — a
 * mismatched owner simply matches nothing.
 */
export async function revokeSession(userId, sessionId) {
  if (!/^[0-9a-f]{24}$/i.test(String(sessionId))) {
    throw badRequest('That is not a session id', 'bad_session_id')
  }

  const session = await Session.findOneAndDelete({ _id: sessionId, user: userId }).lean()
  if (!session) throw notFound('That session is not signed in', 'session_not_found')

  await endLiveConnections(userId, { sessionIds: [String(session._id)], reason: 'signed_out' })

  return { revoked: 1 }
}

/**
 * Ends every session on the account except `keepJti`.
 *
 * "Sign out everywhere else" rather than "everywhere": the person pressing it
 * is signed in on the device they are pressing it from, and taking that away
 * too would answer a request to secure the account by asking them to prove
 * themselves again. Signing this one out is what the sign-out button is for.
 */
export async function revokeOtherSessions(userId, keepJti) {
  const doomed = await Session.find({ user: userId, jti: { $ne: keepJti } })
    .select({ _id: 1 })
    .lean()

  if (doomed.length === 0) return { revoked: 0 }

  await Session.deleteMany({ user: userId, jti: { $ne: keepJti } })
  await endLiveConnections(userId, {
    sessionIds: doomed.map((session) => String(session._id)),
    reason: 'signed_out',
  })

  return { revoked: doomed.length }
}

/**
 * Ends every session on the account, including the caller's.
 *
 * What a password change and a password reset both do before opening a fresh
 * one — there is no point keeping a session that was opened with a credential
 * that no longer exists.
 */
export async function revokeAllSessions(userId, reason = 'password_changed') {
  const doomed = await Session.find({ user: userId }).select({ _id: 1 }).lean()
  if (doomed.length === 0) return { revoked: 0 }

  await Session.deleteMany({ user: userId })
  await endLiveConnections(userId, {
    sessionIds: doomed.map((session) => String(session._id)),
    reason,
  })

  return { revoked: doomed.length }
}

/**
 * Hangs up live connections belonging to `userId`.
 *
 * Deleting the row stops the token being accepted, but acceptance is only
 * checked when a connection is made. A websocket that is already open was
 * authenticated minutes ago and nothing re-examines it, so without this,
 * signing a device out would lock it out of the API while leaving it free to
 * carry on typing on the whiteboard.
 *
 * `sessionIds` narrows it to particular devices, which is what makes signing
 * out one of them mean anything live. Connections record the session they
 * authenticated with for exactly this.
 *
 * Failures are logged, never thrown: the rows are already gone, so the tokens
 * are dead either way, and a connection that survives is refused the moment it
 * next authenticates. Throwing would turn a best-effort cleanup into a failed
 * sign-out.
 */
export async function endLiveConnections(userId, { sessionIds = null, reason = 'signed_out' } = {}) {
  if (!userId) return

  const id = String(userId)
  const only = sessionIds ? new Set(sessionIds.map(String)) : null

  /**
   * Guests share no account, but they carry a random uuid in the same field,
   * so the anonymous flag is checked rather than trusting ids never to
   * collide. The session id is passed separately because each transport keeps
   * it outside the identity it broadcasts.
   */
  const theirs = (user, sessionId) => {
    if (!user || user.anonymous || String(user.id) !== id) return false
    return !only || only.has(String(sessionId))
  }

  try {
    for (const document of getHocuspocus()?.documents?.values() ?? []) {
      for (const { connection } of document?.connections?.values() ?? []) {
        const context = connection.context
        if (theirs(context?.user, context?.sessionId)) connection.close(RECONNECT_FRAME)
      }
    }
  } catch (error) {
    logger.warn({ err: error, user: id }, 'could not close collab connections')
  }

  try {
    const io = getIo()
    if (!io) return

    for (const socket of await io.fetchSockets()) {
      if (!theirs(socket.data.user, socket.data.sessionId)) continue
      // Sent before the disconnect so the client can say why it happened
      // rather than showing a bare "Disconnected".
      socket.emit('session:ended', { reason })
      socket.disconnect(true)
    }
  } catch (error) {
    logger.warn({ err: error, user: id }, 'could not close socket connections')
  }

  // Presence repairs itself: the socket server re-broadcasts a room's roster
  // from its own `disconnect` handler.
}
