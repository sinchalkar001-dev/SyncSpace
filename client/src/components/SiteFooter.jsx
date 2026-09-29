import { Link } from 'react-router-dom'

/**
 * One line at the foot of the pages a stranger can reach.
 *
 * Deliberately small: the policy pages and the page shown when an address
 * matches nothing are places somebody arrives without an account, and each
 * needs a way to the privacy notice and the terms.
 *
 * The year is read at render rather than written down, so it does not quietly
 * go stale in January.
 */
export function SiteFooter() {
  return (
    <footer className="sitefoot">
      <span>© {new Date().getFullYear()} SyncSpace. Real-time collaborative whiteboard &amp; code editor.</span>
      <Link to="/privacy">Privacy</Link>
      <Link to="/terms">Terms</Link>
    </footer>
  )
}
