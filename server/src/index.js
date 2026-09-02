import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { createApp } from './app.js'
import { createHocuspocus } from './collab/hocuspocus.js'
import { setHocuspocus } from './collab/registry.js'
import { createSocketServer } from './realtime/socket.js'
import { setIo } from './realtime/registry.js'
import { connectDatabase, disconnectDatabase } from './db/connect.js'
import { env } from './config/env.js'
import { isAllowedOrigin } from './config/cors.js'
import { logger } from './config/logger.js'
import { initRateLimitStore } from './middleware/rateLimit.js'

const COLLAB_PATH = '/collab'

/**
 * How long to keep trying the port before calling it taken.
 *
 * `node --watch` starts the replacement while the previous process is still
 * letting go, so the first bind can land on a socket that is closing. That is
 * a moment, not a conflict — and the old behaviour treated it as fatal, which
 * under --watch means the server stays dead until somebody saves a file.
 */
const BIND_TIMEOUT_MS = 5000
const BIND_RETRY_MS = 150

/** Binds, waiting out a port that is still being released. */
async function listen(httpServer, port, host) {
  const deadline = Date.now() + BIND_TIMEOUT_MS
  let waited = false

  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => reject(error)
        httpServer.once('error', failed)
        httpServer.listen(port, host, () => {
          httpServer.removeListener('error', failed)
          resolve()
        })
      })

      if (waited) logger.info({ port }, 'port was busy for a moment, now bound')
      return
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' || Date.now() >= deadline) throw error
      waited = true
      await new Promise((resolve) => setTimeout(resolve, BIND_RETRY_MS))
    }
  }
}

/**
 * One HTTP server carries all three surfaces:
 *   /api/v1     Express REST (versioned)
 *   /collab     Hocuspocus (Yjs sync + awareness)
 *   /socket.io  Socket.io (room lifecycle)
 */
export async function startServer({ port = env.PORT, host = env.HOST, connectDb = true } = {}) {
  if (connectDb) await connectDatabase()
  await initRateLimitStore()

  const app = createApp()
  const httpServer = http.createServer(app)
  const hocuspocus = createHocuspocus()
  setHocuspocus(hocuspocus)
  const io = createSocketServer(httpServer)
  setIo(io)
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (request, socket, head) => {
    const host_ = request.headers.host || 'localhost'
    const { pathname } = new URL(request.url, 'http://' + host_)

    // Socket.io installs its own upgrade listener; leave those alone.
    if (pathname.startsWith('/socket.io')) return

    if (pathname !== COLLAB_PATH) {
      socket.destroy()
      return
    }

    // WebSocket handshakes are not covered by the cors middleware, so browser
    // origins are checked here. Without this, any web page could open a sync
    // connection (cross-site WebSocket hijacking). Missing Origin means a
    // non-browser client (curl, tests) and is allowed.
    if (!isAllowedOrigin(request.headers.origin)) {
      logger.warn(
        { origin: request.headers.origin, ip: request.socket.remoteAddress },
        'blocked collab upgrade from disallowed origin'
      )
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      hocuspocus.handleConnection(ws, request)
    })
  })

  await listen(httpServer, port, host)

  const address = httpServer.address()
  logger.info(
    { port: address.port, collab: COLLAB_PATH, anonymous: env.ALLOW_ANONYMOUS },
    'syncspace server listening'
  )

  let closing = null
  const close = () => {
    if (closing) return closing
    closing = (async () => {
      logger.info('shutting down')
      io.close()
      setIo(null)
      await hocuspocus.destroy()
      setHocuspocus(null)
      wss.close()

      /**
       * close() only stops the server accepting; every socket already open
       * keeps it alive, and a browser holds keep-alive connections open for
       * seconds after the last request. Under --watch that is time the old
       * process spends holding the port while its replacement tries to bind.
       */
      httpServer.closeAllConnections?.()
      await new Promise((resolve) => httpServer.close(resolve))
      if (connectDb) await disconnectDatabase()
    })()
    return closing
  }

  return { app, httpServer, hocuspocus, io, close, port: address.port }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const server = await startServer().catch((error) => {
    // A port held by something else is a setup mistake, not a crash, and the
    // stack trace says none of what you need to know to fix it.
    if (error?.code === 'EADDRINUSE') {
      logger.fatal(
        'Port ' + env.PORT + ' is already in use — another server is listening there. ' +
          'Stop it and try again, or start this one on a different port with PORT=4001.'
      )
    } else {
      logger.fatal({ err: error }, 'failed to start')
    }
    process.exit(1)
  })

  /**
   * Shutdown must not outlast its usefulness: whatever is still draining, the
   * port has to be free for the process replacing this one.
   */
  const SHUTDOWN_TIMEOUT_MS = 3000

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      const giveUp = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS)
      giveUp.unref()
      server.close().then(() => process.exit(0))
    })
  }
}
