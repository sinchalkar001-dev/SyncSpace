import { Router } from 'express'
import swaggerUi from 'swagger-ui-express'
import { openapiDocument } from './openapi.js'
import { env } from '../config/env.js'

/**
 * helmet() runs globally with a strict CSP tuned for a JSON API. The Swagger
 * page needs inline styles for its own chrome, so these routes carry their
 * own policy instead of loosening the one every API response inherits.
 */
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export function createDocsRouter({ spec = openapiDocument } = {}) {
  const docsRouter = Router()

  docsRouter.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', DOCS_CSP)
    next()
  })

  // Machine-readable copy of the same document the UI renders, for codegen,
  // Postman imports and contract tests. Nothing else serves the spec.
  docsRouter.get('/openapi.json', (_req, res) => res.json(spec))

  // Asset URLs inside the UI page are relative ("./swagger-ui.css"), so a
  // request for the bare mount ("/docs") is redirected to "/docs/" first:
  // without the slash those resolve against the parent path and 404.
  docsRouter.get('/', (req, res, next) => {
    if (!req.originalUrl.endsWith('/')) {
      res.redirect(req.originalUrl + '/')
      return
    }
    next()
  })

  // `serve` ships the static bundles from swagger-ui-dist; `setup` answers
  // "/" with the page that boots them. persistAuthorization keeps a bearer
  // token across reloads while someone tries the endpoints out.
  docsRouter.use(
    '/',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'SyncSpace API',
      swaggerOptions: { persistAuthorization: true },
    })
  )

  return docsRouter
}

/**
 * Mounts the documentation under exactly one endpoint. Defaults come from
 * the environment at call time; the explicit overrides exist so callers and
 * tests can place or omit it without rebuilding the world.
 */
export function mountDocs(app, { enabled = env.SWAGGER_ENABLED, path = env.SWAGGER_PATH } = {}) {
  if (!enabled || !path) return false
  app.use(path, createDocsRouter())
  return true
}
