import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { isIndexed } from '../lib/seo.js'

export const NOTICE_KEY = 'syncspace:storage-notice'

function dismissed() {
  try {
    return localStorage.getItem(NOTICE_KEY) === 'seen'
  } catch {
    return false
  }
}

/**
 * The cookie notice, which here is a note rather than a question.
 *
 * Nothing on this site needs consent: it sets no cookies, what it keeps in
 * local storage is needed for the thing each value does, and the visit counter
 * stores nothing in the browser at all. A banner offering to accept or refuse
 * would be pretending there was a choice to make, so this only says so, once.
 *
 * Only on the public pages, where a stranger arrives. In a room it would sit
 * on the canvas, and anybody signed in has already passed a page that showed it.
 */
export function StorageNotice() {
  const { pathname } = useLocation()
  const [open, setOpen] = useState(() => !dismissed())

  if (!open || !isIndexed(pathname)) return null

  const close = () => {
    try {
      localStorage.setItem(NOTICE_KEY, 'seen')
    } catch {
      // Storage refused, as in some private windows: closed until the next load.
    }
    setOpen(false)
  }

  return (
    <aside className="storage-note" aria-label="Cookies and storage">
      <p>
        SyncSpace sets no cookies. Your browser keeps your sign-in and a few settings, and visits
        are counted without identifying you. <Link to="/privacy">Read the privacy notice</Link>.
      </p>
      <button type="button" className="btn btn--sm" onClick={close}>
        Got it
      </button>
    </aside>
  )
}
