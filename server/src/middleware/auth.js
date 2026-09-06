import { authenticate, SESSION_REVOKED } from '../services/auth.service.js'
import { unauthorized } from '../errors.js'

function bearer(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

/**
 * Both guards ask `authenticate`, which checks the signature *and* whether the
 * session has since been ended — a signed token cannot be withdrawn, so the
 * account is consulted for the generation it belongs to.
 *
 * That makes them asynchronous. Express 4 does not catch a rejected promise
 * from middleware, so every path here ends in an explicit `next`, and a
 * database failure becomes a 500 through the error handler rather than a
 * request that hangs until it times out.
 */

/** Populates req.user when a live session is present; never rejects. */
export async function optionalAuth(req, _res, next) {
  try {
    const { user } = await authenticate(bearer(req))
    // A revoked token is treated exactly as no token: these routes serve
    // anonymous visitors anyway, and refusing here would turn a public room
    // into an error for someone whose old session simply ended.
    req.user = user
    next()
  } catch (error) {
    next(error)
  }
}

/** Rejects the request unless a live session is present. */
export async function requireAuth(req, _res, next) {
  try {
    const { user, revoked } = await authenticate(bearer(req))

    if (!user) {
      next(
        revoked
          ? unauthorized('Your session ended when the password was changed — sign in again', SESSION_REVOKED)
          : unauthorized('A valid bearer token is required')
      )
      return
    }

    req.user = user
    next()
  } catch (error) {
    next(error)
  }
}
