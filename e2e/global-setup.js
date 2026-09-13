import { request } from '@playwright/test'
import { WebSocket } from 'ws'

/**
 * Waits until the client's dev server can actually reach the API.
 *
 * Playwright only waits for each server to answer on its own port. The client
 * proxies `/api`, `/collab` and `/socket.io` to the backend, and that proxy is
 * not necessarily working the moment the page starts serving — a request made
 * during Vite's first dependency optimisation can come back as a proxy error
 * rather than a response.
 *
 * When that lands on the first test it looks like a product failure: sign-up
 * shows "Something went wrong" and the run ends on a red test that passes
 * every time it is run again. One warm request up front costs a moment and
 * removes the whole class of flake.
 */
/**
 * Refuses to start against a backend that will not accept this origin.
 *
 * `reuseExistingServer` adopts whatever is already listening on the port, so a
 * server left over from another session — started without the suite's
 * CORS_ORIGIN — gets used as if it were ours. Every room test then waits for a
 * "Connected" that can never arrive, and thirty tests fail for one reason that
 * none of them mention.
 */
/**
 * Where the backend is.
 *
 * Configurable because the ports already are: a machine with something else on
 * 4000 can point a run elsewhere, and this check has to follow it rather than
 * asserting things about whatever happens to be on the default.
 */
const API_ORIGIN = process.env.E2E_API_ORIGIN ?? 'http://127.0.0.1:4000'

async function assertCollabAcceptsOrigin(origin) {
  const socket = new WebSocket(API_ORIGIN.replace(/^http/, 'ws') + '/collab', { origin })

  await new Promise((resolve, reject) => {
    socket.once('open', () => {
      socket.close()
      resolve()
    })
    socket.once('unexpected-response', (_request, response) => {
      reject(
        new Error(
          'The server at ' +
            API_ORIGIN +
            ' refused a collab connection from ' +
            origin +
            ' (HTTP ' +
            response.statusCode +
            '). It is almost certainly a leftover server started without ' +
            'CORS_ORIGIN=' +
            origin +
            '. Stop whatever is listening there and run the suite again.'
        )
      )
    })
    socket.once('error', reject)
  })
}

export default async function globalSetup(config) {
  const baseURL = config.projects[0]?.use?.baseURL || 'http://localhost:5180'
  const context = await request.newContext({ baseURL })
  const deadline = Date.now() + 60000

  try {
    for (;;) {
      // Any proxied endpoint would do; this one needs no database.
      const ok = await context
        .get('/api/v1/runners')
        .then((response) => response.ok())
        .catch(() => false)

      if (ok) {
        await assertCollabAcceptsOrigin(baseURL)
        return
      }

      if (Date.now() > deadline) {
        throw new Error('the client never proxied a request through to the API')
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  } finally {
    await context.dispose()
  }
}
