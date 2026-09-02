import { defineConfig } from 'vitest/config'
import { createLogger } from 'vite'
import react from '@vitejs/plugin-react'

// The backend (Express + Hocuspocus + Socket.io) is expected on one HTTP server.
// Dev requests are proxied so the client can use same-origin relative paths.
const BACKEND = process.env.VITE_BACKEND_ORIGIN || 'http://localhost:4000'

/**
 * Proxy failures, said once and in words.
 *
 * A room holds two live sockets — the collaborative document and presence —
 * and the proxy reports each severed one as its own stack trace. So a single
 * `node --watch` restart of the backend prints four traces that between them
 * say nothing actionable, and a backend that is simply not running repeats
 * that for as long as the browser keeps retrying.
 *
 * Only the proxy's own noise is rewritten. Everything else Vite reports goes
 * through untouched.
 */
// Unanchored on purpose: Vite wraps the message in colour codes, so it never
// starts where you would expect it to.
const PROXY_NOISE = /(ws|http) proxy (socket )?error/

const REPEAT_WINDOW_MS = 5000

function quietProxyLogger() {
  const logger = createLogger()
  const inherited = logger.error.bind(logger)

  let previous = { line: null, at: 0 }

  logger.error = (message, options) => {
    const text = String(message)

    if (!PROXY_NOISE.test(text)) {
      previous = { line: null, at: 0 }
      inherited(message, options)
      return
    }

    // AggregateError hides the useful part in a bracket; both shapes match.
    const code = text.match(/E[A-Z]{3,}/)?.[0] ?? 'unknown error'

    const line =
      code === 'ECONNREFUSED'
        ? 'backend not reachable on ' + BACKEND + ' — start it with:  npm run dev:server'
        : 'backend connection dropped (' + code + ') — the browser reconnects on its own'

    // One restart severs every socket at once. Saying so once is enough.
    const now = Date.now()
    if (line === previous.line && now - previous.at < REPEAT_WINDOW_MS) return

    previous = { line, at: now }
    inherited(line)
  }

  return logger
}

export default defineConfig({
  plugins: [react()],
  customLogger: quietProxyLogger(),
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/collab': { target: BACKEND, ws: true, changeOrigin: true },
      '/socket.io': { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: {
    // Monaco ships a lot of code; keep it in its own chunk instead of one huge bundle.
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor'],
          konva: ['konva', 'react-konva'],
          yjs: ['yjs', '@hocuspocus/provider', 'y-monaco'],
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
    restoreMocks: true,
  },
})
