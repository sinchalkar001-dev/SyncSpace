import { Link } from 'react-router-dom'
import { Icon } from './ui/Icon.jsx'

const POINTS = [
  'Edits merge through CRDTs — no lost work when two people type at once',
  'Rooms survive a restart and can be replayed from the update log',
  'Invite by link; private rooms stay owner and member only',
]

/**
 * Shell for the sign-in and registration screens.
 *
 * The value panel beside the form is decorative and hidden below 900px, where
 * the form deserves the whole width. It is marked `aria-hidden` because it
 * repeats what the page already says.
 */
export function AuthCard({ title, subtitle, children, footer }) {
  return (
    <main className="auth" id="main">
      <div className="auth__panel">
        <div className="auth__card">
          <Link to="/" className="auth__brand">
            <span className="brand-mark">SS</span>
            <span className="brand-word">SyncSpace</span>
          </Link>

          <h1 className="auth__title">{title}</h1>
          {subtitle && <p className="auth__subtitle">{subtitle}</p>}

          {children}

          {footer && <div className="auth__footer">{footer}</div>}
        </div>
      </div>

      <aside className="auth__side" aria-hidden="true">
        <div className="auth__side-inner">
          <p className="auth__quote">A shared whiteboard and code editor, in one room.</p>
          <ul className="auth__points">
            {POINTS.map((point) => (
              <li key={point}>
                <Icon name="check" size={16} />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </main>
  )
}
