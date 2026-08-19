import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import pinoHttp from 'pino-http'
import mongoose from 'mongoose'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import { authRouter } from './routes/auth.routes.js'
import { roomsRouter } from './routes/rooms.routes.js'
import { errorHandler, notFoundHandler } from './middleware/error.js'

export function createApp() {
  const app = express()

  app.disable('x-powered-by')
  app.set('trust proxy', 1)

  app.use(helmet())
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
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

  const api = express.Router()
  api.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
    })
  )
  api.use('/auth', authRouter)
  api.use('/rooms', roomsRouter)

  app.use('/api', api)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
