import { describe, expect, it } from 'vitest'
import { INDEXED_PATHS, isIndexed, robotsTxt, siteUrlFrom, sitemapXml, socialTags } from './seo.js'

describe('socialTags', () => {
  const content = (tags, key) => tags.find((tag) => tag.property === key || tag.name === key)?.content

  it('points link previews at the image by its full address', () => {
    const tags = socialTags('https://syncspace.example.com')
    expect(content(tags, 'og:image')).toBe('https://syncspace.example.com/og-image.jpg')
    expect(content(tags, 'twitter:image')).toBe('https://syncspace.example.com/og-image.jpg')
    expect(content(tags, 'twitter:card')).toBe('summary_large_image')
    expect(content(tags, 'og:url')).toBe('https://syncspace.example.com/')
  })

  it('asks for a text card when there is no address to build an image link on', () => {
    expect(socialTags(null)).toEqual([{ name: 'twitter:card', content: 'summary' }])
  })
})

describe('isIndexed', () => {
  it('lists the landing page, the ways in, and the two policies', () => {
    for (const path of ['/', '/login', '/register', '/privacy', '/terms']) expect(isIndexed(path)).toBe(true)
  })

  /** The reason it is opt-in: a room code in a search result is a leak. */
  it('lists nothing private, and nothing it was not told about', () => {
    for (const path of ['/room/abc123', '/dashboard', '/reset-password', '/forgot-password', '/nope']) {
      expect(isIndexed(path)).toBe(false)
    }
  })
})

describe('robotsTxt', () => {
  it('keeps crawlers out of rooms and one-time links', () => {
    const robots = robotsTxt(null)
    expect(robots).toContain('Disallow: /room/')
    expect(robots).toContain('Disallow: /reset-password')
    expect(robots).toContain('Disallow: /accept-invitation')
  })

  it('points at the sitemap only when there is an address to give', () => {
    expect(robotsTxt(null)).not.toContain('Sitemap')
    expect(robotsTxt('https://syncspace.example.com')).toContain(
      'Sitemap: https://syncspace.example.com/sitemap.xml'
    )
  })
})

describe('sitemapXml', () => {
  it('holds exactly the indexed pages, as absolute addresses', () => {
    const xml = sitemapXml('https://syncspace.example.com')
    expect(xml.match(/<loc>/g)).toHaveLength(INDEXED_PATHS.length)
    expect(xml).toContain('<loc>https://syncspace.example.com/</loc>')
    expect(xml).toContain('<loc>https://syncspace.example.com/login</loc>')
    expect(xml).not.toContain('/room/')
  })
})

describe('siteUrlFrom', () => {
  it('is null when nothing was configured', () => {
    expect(siteUrlFrom(undefined)).toBeNull()
    expect(siteUrlFrom('')).toBeNull()
  })

  it('normalises an origin, trailing slash and all', () => {
    expect(siteUrlFrom('https://syncspace.example.com/')).toBe('https://syncspace.example.com')
  })

  it('refuses anything a sitemap could not be built on', () => {
    for (const bad of ['syncspace.example.com', 'ftp://example.com', 'https://example.com/app', 'https://example.com/?a=1']) {
      expect(() => siteUrlFrom(bad)).toThrow(/SITE_URL/)
    }
  })
})
