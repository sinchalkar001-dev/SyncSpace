import { Link } from 'react-router-dom'
import { Icon } from '../components/ui/Icon.jsx'

export default function NotFound() {
  return (
    <main className="gate" id="main">
      <div className="gate__card">
        <span className="empty__icon" style={{ margin: '0 auto var(--space-4)' }}>
          <Icon name="search" size={22} />
        </span>

        <h1>Nothing here</h1>
        <p>That link does not point at a room or a page we know about.</p>
        <p className="muted">
          If someone shared a room code with you, join it from the home page — codes are
          case-sensitive.
        </p>

        <div className="gate__actions">
          <Link className="btn btn--primary" to="/">
            Go home
          </Link>
          <Link className="btn" to="/dashboard">
            My rooms
          </Link>
        </div>
      </div>
    </main>
  )
}
