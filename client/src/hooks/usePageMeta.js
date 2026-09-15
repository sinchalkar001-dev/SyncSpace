import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { SITE_NAME, isIndexed } from '../lib/seo.js'

/**
 * A page's title and description, and whether search engines may list it.
 *
 * Every route is served the same index.html, so without this every tab,
 * bookmark and search result reads the same whatever the page shows.
 *
 * Whether a page is indexed is decided by its path in lib/seo.js rather than
 * passed in, so no page can forget to be private. The canonical address drops
 * the query string: a token or a tracking parameter is never part of what a
 * page is, and a search engine that kept one would list the same page twice.
 */

// What index.html says, for the pages that say nothing more specific.
const DEFAULTS = {
  title: document.title,
  description: document.head.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
}

function metaNamed(name) {
  let element = document.head.querySelector('meta[name="' + name + '"]')
  if (!element) {
    element = document.createElement('meta')
    element.setAttribute('name', name)
    document.head.appendChild(element)
  }
  return element
}

export function usePageMeta({ title, description } = {}) {
  const { pathname } = useLocation()

  useEffect(() => {
    const indexed = isIndexed(pathname)

    document.title = title ? title + ' · ' + SITE_NAME : DEFAULTS.title
    metaNamed('description').setAttribute('content', description || DEFAULTS.description)
    metaNamed('robots').setAttribute('content', indexed ? 'index, follow' : 'noindex, nofollow')

    let canonical = document.head.querySelector('link[rel="canonical"]')
    if (!indexed) {
      canonical?.remove()
      return
    }
    if (!canonical) {
      canonical = document.createElement('link')
      canonical.setAttribute('rel', 'canonical')
      document.head.appendChild(canonical)
    }
    canonical.setAttribute('href', window.location.origin + pathname)
  }, [title, description, pathname])
}
