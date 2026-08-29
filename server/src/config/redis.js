import { createClient } from 'redis'
import { env } from './env.js'
import { logger } from './logger.js'

let client = null
let connecting = false

/**
 * Returns a shared Redis client for the process, creating one on first call.
 * When REDIS_URL is unset or the connection fails, returns null so callers
 * can fall back to an in-memory store.
 */
export async function getRedisClient() {
  if (client) return client
  if (!env.REDIS_URL) return null
  if (connecting) return null

  connecting = true
  try {
    client = createClient({ url: env.REDIS_URL })

    client.on('error', (err) => {
      logger.warn({ err }, 'redis connection lost; rate limiting reverts to in-memory')
      client = null
    })

    client.on('ready', () => {
      logger.info('redis connected for rate limiting')
    })

    await client.connect()
    return client
  } catch (err) {
    logger.warn({ err }, 'redis unavailable; rate limiting using in-memory store')
    client = null
    return null
  } finally {
    connecting = false
  }
}
