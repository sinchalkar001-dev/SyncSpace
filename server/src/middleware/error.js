import { logger } from '../config/logger.js'
import { isProduction } from '../config/env.js'

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } })
}

// The 4-arity signature is what marks this as Express error middleware.
export function errorHandler(err, req, res, _next) {
  const status = err.status || 500

  if (status >= 500) logger.error({ err, path: req.path }, 'request failed')
  else logger.warn({ code: err.code, path: req.path, msg: err.message }, 'request rejected')

  res.status(status).json({
    error: {
      code: err.code || 'internal_error',
      message: status >= 500 && isProduction ? 'Internal server error' : err.message,
    },
  })
}
