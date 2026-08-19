import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <main className="gate">
      <div className="gate__card">
        <h1>Nothing here</h1>
        <p className="muted">That link does not point at a room or a page we know about.</p>
        <div className="gate__actions">
          <Link className="btn btn--primary" to="/">
            Go home
          </Link>
        </div>
      </div>
    </main>
  )
}
