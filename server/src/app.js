import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import pinoHttp from 'pino-http'
import mongoose from 'mongoose'
import { isAllowedOrigin } from './config/cors.js'
import { logger } from './config/logger.js'
import { createAuthRouter } from './routes/auth.routes.js'
import { createRoomsRouter } from './routes/rooms.routes.js'
import { createRunnersRouter } from './routes/runners.routes.js'
import { createFilesRouter } from './routes/files.routes.js'
import { mountDocs } from './docs/docs.routes.js'
import { createRateLimiters } from './middleware/rateLimit.js'
import { errorHandler, notFoundHandler } from './middleware/error.js'

export function createApp() {
  const app = express()

  app.disable('x-powered-by')
  app.set('trust proxy', 1)

  app.use(helmet())
  app.use(
    cors({
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
      credentials: true,
    })
  )
  app.use(express.json({ limit: '256kb' }))
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
    })
  )

  app.get('/health', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1
    res.status(dbUp ? 200 : 503).json({
      status: dbUp ? 'ok' : 'degraded',
      db: dbUp ? 'connected' : 'disconnected',
      uptime: Math.round(process.uptime()),
    })
  })

  // Browsable API documentation. One endpoint, placed by SWAGGER_PATH and
  // removable with SWAGGER_ENABLED=false; outside the versioned API so
  // browsing the docs never spends rate-limit budget.
  mountDocs(app)

  const api = express.Router()
  const { apiLimiter } = createRateLimiters()
  api.use(apiLimiter)
  api.use('/auth', createAuthRouter())
  api.use('/rooms', createRoomsRouter())
  api.use('/rooms/:roomId/files', createFilesRouter())
  api.use('/runners', createRunnersRouter())

  app.use('/api/v1', api)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
