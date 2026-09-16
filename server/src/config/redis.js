import { env } from './env.js'
import { logger } from './logger.js'

let client = null
let connecting = false

/**
 * Returns a shared Redis client for the process, creating one on first call.
 * When REDIS_URL is unset or the connection fails, returns null so callers
 * can fall back to an in-memory store.
 *
 * The client library is imported here, on first use, rather than at the top of
 * the module. It is one of the heaviest things the server loads — a quarter of
 * a second warm and closer to a second from a cold disk — and a server without
 * REDIS_URL, which is every development machine, never uses it at all. Every
 * start and every `--watch` restart was paying for it anyway.
 */
export async function getRedisClient() {
  if (client) return client
  if (!env.REDIS_URL) return null
  if (connecting) return null

  connecting = true
  try {
    const { createClient } = await import('redis')
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
