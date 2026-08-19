import { verifyToken } from '../services/auth.service.js'
import { unauthorized } from '../errors.js'

function bearer(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

/** Populates req.user when a valid token is present; never rejects. */
export function optionalAuth(req, _res, next) {
  const payload = verifyToken(bearer(req))
  req.user = payload ? { id: payload.sub, name: payload.name } : null
  next()
}

/** Rejects the request unless a valid token is present. */
export function requireAuth(req, _res, next) {
  const payload = verifyToken(bearer(req))
  if (!payload) {
    next(unauthorized('A valid bearer token is required'))
    return
  }
  req.user = { id: payload.sub, name: payload.name }
  next()
}
