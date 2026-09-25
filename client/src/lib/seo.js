/**
 * What search engines are told about this app.
 *
 * Very little of it should be found. A room, an invitation, a verification or
 * reset link is somebody's private address, and the dashboard is behind a
 * sign-in; a search result pointing at any of them is useless at best and at
 * worst publishes a room code. So indexing is opt-in, by path: the landing page
 * and the two ways in are listed, and every other page — including any added
 * later — is `noindex` until it is listed here.
 *
 * Read twice: by the build, for robots.txt and sitemap.xml, and by every page
 * for its robots meta. One list, so the two cannot disagree.
 */

export const SITE_NAME = 'SyncSpace'

export const INDEXED_PATHS = ['/', '/login', '/register', '/privacy']

/** Not crawled at all. Prefixes, matched the way robots.txt matches them. */
const PRIVATE_PATHS = [
  '/room/',
  '/dashboard',
  '/verify-email',
  '/check-email',
  '/accept-invitation',
  '/reset-password',
]

export const isIndexed = (pathname) => INDEXED_PATHS.includes(pathname)

/**
 * The deployment's public origin, or null when none was given.
 *
 * Only the deployment knows it, and a sitemap needs absolute addresses, so a
 * malformed value fails the build rather than publishing a sitemap of links
 * that go nowhere.
 */
export function siteUrlFrom(value) {
  if (!value) return null

  let url = null
  try {
    url = new URL(value)
  } catch {
    // Reported below with the rest.
  }

  if (!url || !/^https?:$/.test(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      'SITE_URL must be scheme://host[:port] without a path, e.g. https://syncspace.example.com'
    )
  }
  return url.origin
}

export function robotsTxt(siteUrl) {
  return [
    'User-agent: *',
    ...PRIVATE_PATHS.map((path) => 'Disallow: ' + path),
    ...(siteUrl ? ['', 'Sitemap: ' + siteUrl + '/sitemap.xml'] : []),
    '',
  ].join('\n')
}

export function sitemapXml(siteUrl) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...INDEXED_PATHS.map((path) => '  <url><loc>' + siteUrl + path + '</loc></url>'),
    '</urlset>',
    '',
  ].join('\n')
}
