import { request } from '@playwright/test'

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

      if (ok) return

      if (Date.now() > deadline) {
        throw new Error('the client never proxied a request through to the API')
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  } finally {
    await context.dispose()
  }
}
