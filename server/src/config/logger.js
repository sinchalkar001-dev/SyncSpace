import pino from 'pino'
import { env, isProduction } from './env.js'

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: isProduction
    ? undefined
    : { target: 'pino/file', options: { destination: 1 } },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.currentPassword', '*.newPassword', '*.token'],
    remove: true,
  },
})
