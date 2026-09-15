import { defineConfig } from 'vitest/config'
import { createLogger } from 'vite'
import react from '@vitejs/plugin-react'
import { robotsTxt, siteUrlFrom, sitemapXml } from './src/lib/seo.js'

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

/**
 * robots.txt, and sitemap.xml when the build knows its public address.
 *
 * Generated rather than kept in public/ because the sitemap needs absolute
 * URLs, which only the deployment knows, and both files read the same list of
 * pages the app itself uses to decide what is indexed (src/lib/seo.js).
 */
function crawlerFiles() {
  const site = siteUrlFrom(process.env.SITE_URL)
  const files = { 'robots.txt': robotsTxt(site), ...(site && { 'sitemap.xml': sitemapXml(site) }) }

  return {
    name: 'syncspace-crawler-files',
    generateBundle() {
      for (const [fileName, source] of Object.entries(files)) {
        this.emitFile({ type: 'asset', fileName, source })
      }
    },
  }
}

/**
 * Vendor code in chunks of its own, which change only when a dependency does:
 * a deploy of the app then costs a returning visitor the app's code, not React
 * and the editor over again.
 *
 * Matched by path, not by package name. Naming 'monaco-editor' as an entry
 * would pull in the full distribution that monacoSetup.js exists to avoid, and
 * grammars and language services stay out of the chunk so each is still
 * fetched only when its language is first opened.
 */
const VENDOR_CHUNKS = [
  ['monaco', /\/node_modules\/monaco-editor\/(?!esm\/vs\/(basic-languages|language)\/)/],
  ['konva', /\/node_modules\/(konva|react-konva)\//],
  ['yjs', /\/node_modules\/(yjs|y-monaco|y-protocols|lib0|@hocuspocus)\//],
  ['react', /\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run)\//],
]

export default defineConfig({
  plugins: [react(), crawlerFiles()],
  customLogger: quietProxyLogger(),
  server: {
    port: 5173,

    /**
     * Transformed while the server is starting rather than while somebody is
     * waiting. The room is the expensive one — it pulls in the editor, the
     * canvas and the CRDT layer — and paying for it during boot is free,
     * because nobody is looking at a page yet.
     */
    warmup: {
      clientFiles: ['./src/main.jsx', './src/pages/Room.jsx', './src/pages/Dashboard.jsx'],
    },

    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/collab': { target: BACKEND, ws: true, changeOrigin: true },
      '/socket.io': { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => VENDOR_CHUNKS.find(([, pattern]) => pattern.test(id))?.[0],
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
