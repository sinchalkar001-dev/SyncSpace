import { Link } from 'react-router-dom'

/**
 * One line at the foot of the pages a stranger can reach.
 *
 * Deliberately small: the landing page, the privacy notice and the page shown
 * when an address matches nothing are the three places somebody arrives
 * without an account, and all three need a way to the privacy notice.
 *
 * The year is read at render rather than written down, so it does not quietly
 * go stale in January.
 */
export function SiteFooter() {
  return (
    <footer className="sitefoot">
      <span>© {new Date().getFullYear()} SyncSpace. Real-time collaborative whiteboard &amp; code editor.</span>
      <Link to="/privacy">Privacy</Link>
    </footer>
  )
}
