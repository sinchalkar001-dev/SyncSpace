import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { createApp } from './app.js'
import { createHocuspocus } from './collab/hocuspocus.js'
import { setHocuspocus } from './collab/registry.js'
import { createSocketServer } from './realtime/socket.js'
import { connectDatabase, disconnectDatabase } from './db/connect.js'
import { env } from './config/env.js'
import { logger } from './config/logger.js'

const COLLAB_PATH = '/collab'

/**
 * One HTTP server carries all three surfaces:
 *   /api/v1     Express REST (versioned)
 *   /collab     Hocuspocus (Yjs sync + awareness)
 *   /socket.io  Socket.io (room lifecycle)
 */
export async function startServer({ port = env.PORT, host = env.HOST, connectDb = true } = {}) {
  if (connectDb) await connectDatabase()

  const app = createApp()
  const httpServer = http.createServer(app)
  const hocuspocus = createHocuspocus()
  setHocuspocus(hocuspocus)
  const io = createSocketServer(httpServer)
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

    wss.handleUpgrade(request, socket, head, (ws) => {
      hocuspocus.handleConnection(ws, request)
    })
  })

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, resolve)
  })

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
      await hocuspocus.destroy()
      setHocuspocus(null)
      wss.close()
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
    logger.fatal({ err: error }, 'failed to start')
    process.exit(1)
  })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close().then(() => process.exit(0))
    })
  }
}
