import { forbidden } from '../errors.js'
import { CAPABILITIES, CAPABILITY_LABELS, can, describeAccess, roleFor } from '../permissions.js'
import { ensureRoom } from '../services/room.service.js'

/**
 * The gate every room route passes through.
 *
 * Routes used to each fetch the room and ask `canAccess` themselves, which
 * worked while there was one question to ask. With six roles there are
 * sixteen, and a per-route copy of that check is how one endpoint ends up
 * asking a slightly different question from its neighbour — usually the one
 * that was added last, in a hurry.
 *
 * `ensureRoom` rather than `getRoom`, matching what these routes already did:
 * a room typed straight into the address bar exists as a live document before
 * anything is written about it, and "not found" on the first action in a brand
 * new room is nonsense.
 */

/**
 * Two different refusals, and the difference is worth keeping.
 *
 * Somebody with no role at all cannot see the room — that is `room_forbidden`,
 * the code this API has always used, and the clients that already handle it
 * keep working. Somebody who is *in* the room but lacks one capability gets
 * `permission_denied` and is told which thing they cannot do, because "you do
 * not have access to this room" is actively misleading when they are looking
 * at it.
 */
export function refusalFor(room, userId, capability) {
  if (!roleFor(room, userId)) {
    return forbidden('You do not have access to this room', 'room_forbidden')
  }

  const what = CAPABILITY_LABELS[capability] ?? 'do that'
  const error = forbidden('You do not have permission to ' + what + ' in this room', 'permission_denied')
  error.capability = capability
  error.role = roleFor(room, userId)
  return error
}

/**
 * Loads the room and works out what the caller may do in it, without deciding
 * anything. For routes whose answer depends on the role rather than being
 * gated by it — the room read, which returns a different shape to an owner.
 */
export async function attachRoom(req, _res, next) {
  try {
    req.room = await ensureRoom(req.params.roomId)
    req.access = describeAccess(req.room, req.user?.id)
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Refuses the request unless the caller holds `capability` in this room.
 *
 * Must run after `optionalAuth` or `requireAuth`; it reads `req.user`. Express
 * 4 does not catch a rejected promise from middleware, so every path ends in
 * an explicit `next`.
 */
export function requirePermission(capability) {
  return async function permissionGuard(req, _res, next) {
    try {
      if (!req.room) {
        req.room = await ensureRoom(req.params.roomId)
        req.access = describeAccess(req.room, req.user?.id)
      }

      if (!can(req.room, req.user?.id, capability)) {
        next(refusalFor(req.room, req.user?.id, capability))
        return
      }

      next()
    } catch (error) {
      next(error)
    }
  }
}

export { CAPABILITIES }
