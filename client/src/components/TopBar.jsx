import { Link, useLocation } from 'react-router-dom'
import { Icon } from './ui/Icon.jsx'

/**
 * The application header.
 *
 * The dashboard and the room each used to hand-roll their own bar with
 * near-identical markup that drifted apart over time. One component, composed
 * through children, keeps the brand, spacing, and behaviour identical wherever
 * it appears.
 *
 * `flush` is the room variant: tighter padding and non-sticky, because the room
 * fills the viewport and manages its own scrolling.
 */
export function TopBar({ flush = false, children }) {
  return (
    <header className={'topbar' + (flush ? ' topbar--flush' : '')}>{children}</header>
  )
}

/** Wordmark that navigates home. Renders as a button when given `onClick`. */
export function Brand({ to, onClick, label = 'SyncSpace', showWord = true, title }) {
  const inner = (
    <>
      <span className="brand-mark">SS</span>
      {showWord && <span className="brand-word">{label}</span>}
    </>
  )

  if (onClick) {
    return (
      <button type="button" className="topbar__brand" onClick={onClick} title={title} aria-label={title || label}>
        {inner}
      </button>
    )
  }

  return (
    <Link to={to || '/'} className="topbar__brand" aria-label={label}>
      {inner}
    </Link>
  )
}

/**
 * Primary navigation with a current-page marker.
 *
 * Labels collapse to icons on narrow screens (see the 860px rule in pages.css)
 * rather than wrapping or pushing the account menu off the bar.
 */
export function TopNav({ items }) {
  const { pathname } = useLocation()

  return (
    <nav className="topbar__nav" aria-label="Main">
      {items.map((item) => {
        const active = pathname === item.to || pathname.startsWith(item.to + '/')
        return (
          <Link
            key={item.to}
            to={item.to}
            className={'topbar__link' + (active ? ' is-active' : '')}
            aria-current={active ? 'page' : undefined}
          >
            {item.icon && <Icon name={item.icon} size={15} />}
            <span className="topbar__link-label">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
