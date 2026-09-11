import { describe, expect, it } from 'vitest'
import { createRoomsRouter } from '../src/routes/rooms.routes.js'
import { createCommentsRouter } from '../src/routes/comments.routes.js'
import { openapiDocument } from '../src/docs/openapi.js'

/**
 * The rooms section of the OpenAPI document is verified against the live
 * routers themselves: their layer stacks are walked for methods, paths and
 * auth middleware, then compared with what the document claims. If a route is
 * added, removed, re-authed or renamed without updating the docs (or vice
 * versa), this file fails.
 *
 * Comments have a router of their own, mounted under a room, so both are
 * walked — each with the prefix app.js mounts it at.
 */

const ROOMS_PREFIX = '/api/v1/rooms'
const COMMENTS_PREFIX = ROOMS_PREFIX + '/{roomId}/comments'
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])

/** Flattens an Express router into [{ method, path, requireAuth, optionalAuth }]. */
function actualRoutes(router, prefix) {
  const routes = []
  for (const layer of router.stack) {
    if (!layer.route) continue
    const route = layer.route
    for (const method of Object.keys(route.methods)) {
      if (!HTTP_METHODS.has(method) || !route.methods[method]) continue
      routes.push({
        method,
        // Express stores params as ":roomId"; OpenAPI as "{roomId}".
        path: prefix + (route.path === '/' ? '' : route.path).replace(/:(\w+)/g, '{$1}'),
        requireAuth: route.stack.some((l) => l.name === 'requireAuth'),
        optionalAuth: route.stack.some((l) => l.name === 'optionalAuth'),
      })
    }
  }
  return routes
}

const operationOf = (path, method) => openapiDocument.paths[path]?.[method]

describe('room routes ↔ OpenAPI parity', () => {
  const routes = [
    ...actualRoutes(createRoomsRouter(), ROOMS_PREFIX),
    ...actualRoutes(createCommentsRouter(), COMMENTS_PREFIX),
  ].sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method))

  it('the router actually mounts room routes to compare against', () => {
    expect(routes.length).toBeGreaterThanOrEqual(10)
  })

  it('documents every mounted route and method', () => {
    for (const { method, path } of routes) {
      expect(operationOf(path, method), `${method.toUpperCase()} ${path} is undocumented`).toBeDefined()
    }
  })

  it('documents no room route or method that does not exist', () => {
    const actual = new Set(routes.map((r) => r.method + ' ' + r.path))
    for (const [path, operations] of Object.entries(openapiDocument.paths)) {
      if (!path.startsWith(ROOMS_PREFIX)) continue
      for (const method of Object.keys(operations)) {
        if (!HTTP_METHODS.has(method)) continue
        expect(actual.has(method + ' ' + path), `documented ${method.toUpperCase()} ${path} has no route`).toBe(true)
      }
    }
  })

  it('routes guarded by requireAuth never claim anonymous access', () => {
    for (const { method, path, requireAuth } of routes) {
      if (!requireAuth) continue
      const security = operationOf(path, method)?.security ?? openapiDocument.security
      expect(security, `${method.toUpperCase()} ${path}`).toEqual([{ bearerAuth: [] }])
    }
  })

  it('optionalAuth routes declare their security explicitly, so anonymity is visible', () => {
    for (const { method, path, optionalAuth } of routes) {
      if (!optionalAuth) continue
      const operation = operationOf(path, method)
      expect(operation?.security, `${method.toUpperCase()} ${path}`).toEqual([{ bearerAuth: [] }])
    }
  })
})
