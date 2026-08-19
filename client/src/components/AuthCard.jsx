import { Link } from 'react-router-dom'

export function AuthCard({ title, subtitle, children, footer }) {
  return (
    <main className="auth">
      <div className="auth__card">
        <Link to="/" className="auth__brand">
          <span className="brand-mark">SS</span>
          SyncSpace
        </Link>
        <h1 className="auth__title">{title}</h1>
        {subtitle && <p className="auth__subtitle">{subtitle}</p>}
        {children}
        {footer && <div className="auth__footer">{footer}</div>}
      </div>
    </main>
  )
}
