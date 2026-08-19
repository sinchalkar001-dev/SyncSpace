import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth.js'
import { useToast } from './ui/useToast.js'

/**
 * Account menu. Signed-in users get sign-out; guests get a route to sign in,
 * plus an inline rename since their name is the only identity they have.
 */
export function UserMenu({ compact = false }) {
  const { isAuthenticated, user, identity, logout, renameGuest } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const triggerRef = useRef(null)

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return undefined

    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) close()
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        close()
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  const onSignOut = useCallback(() => {
    close()
    logout()
    toast.success('Signed out')
    navigate('/login', { replace: true })
  }, [close, logout, toast, navigate])

  return (
    <div className="usermenu" ref={containerRef}>
      <button
        type="button"
        className="usermenu__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        ref={triggerRef}
      >
        <span className="usermenu__avatar" style={{ background: identity.color }}>
          {identity.name.slice(0, 1).toUpperCase()}
        </span>
        {!compact && <span className="usermenu__name">{identity.name}</span>}
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M2 4.5 L6 8.5 L10 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>

      {open && (
        <div className="usermenu__panel" role="menu">
          <div className="usermenu__header">
            <strong>{identity.name}</strong>
            <span>{isAuthenticated ? user.email : 'Guest session'}</span>
          </div>

          {isAuthenticated ? (
            <>
              <button
                type="button"
                className="usermenu__item"
                role="menuitem"
                onClick={() => {
                  close()
                  navigate('/dashboard')
                }}
              >
                My rooms
              </button>
              <button
                type="button"
                className="usermenu__item usermenu__item--danger"
                role="menuitem"
                onClick={onSignOut}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <label className="usermenu__field">
                <span>Display name</span>
                <input
                  value={identity.name}
                  onChange={(event) => renameGuest(event.target.value)}
                  maxLength={32}
                />
              </label>
              <button
                type="button"
                className="usermenu__item"
                role="menuitem"
                onClick={() => {
                  close()
                  navigate('/login')
                }}
              >
                Sign in
              </button>
              <button
                type="button"
                className="usermenu__item"
                role="menuitem"
                onClick={() => {
                  close()
                  navigate('/register')
                }}
              >
                Create an account
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
