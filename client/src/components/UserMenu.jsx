import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth.js'
import { useToast } from './ui/useToast.js'
import { useDismissable } from '../hooks/useDismissable.js'
import { Icon } from './ui/Icon.jsx'
import { ChangePasswordDialog } from './ChangePasswordDialog.jsx'

/**
 * Account menu. Signed-in users get their account controls and sign-out;
 * guests get a route to sign in, plus an inline rename since their display
 * name is the only identity they have.
 */
export function UserMenu({ compact = false }) {
  const { isAuthenticated, user, identity, logout, renameGuest } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  const [open, setOpen] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const containerRef = useRef(null)
  const triggerRef = useRef(null)

  const close = useCallback(() => setOpen(false), [])
  useDismissable(open, close, { containerRef, triggerRef })

  const onSignOut = useCallback(() => {
    close()
    logout()
    toast.success('Signed out')
    navigate('/login', { replace: true })
  }, [close, logout, toast, navigate])

  const go = (path) => () => {
    close()
    navigate(path)
  }

  return (
    <div className="usermenu" ref={containerRef}>
      <button
        type="button"
        className="usermenu__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        /* Explicit, because the name collapses to just the avatar letter on
           narrow screens and an initial is not a usable label. */
        aria-label={identity.name + ' — account menu'}
        ref={triggerRef}
      >
        <span className="usermenu__avatar" style={{ background: identity.color }}>
          {identity.name.slice(0, 1).toUpperCase()}
        </span>
        {!compact && <span className="usermenu__name">{identity.name}</span>}
        <Icon name="chevronDown" size={12} className="usermenu__chevron" />
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
                onClick={go('/dashboard')}
              >
                <Icon name="grid" size={15} />
                My rooms
              </button>
              <button
                type="button"
                className="usermenu__item"
                role="menuitem"
                onClick={() => {
                  close()
                  setChangingPassword(true)
                }}
              >
                <Icon name="key" size={15} />
                Change password
              </button>
              <button
                type="button"
                className="usermenu__item usermenu__item--danger"
                role="menuitem"
                onClick={onSignOut}
              >
                <Icon name="logOut" size={15} />
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
              <button type="button" className="usermenu__item" role="menuitem" onClick={go('/login')}>
                <Icon name="logOut" size={15} />
                Sign in
              </button>
              <button
                type="button"
                className="usermenu__item"
                role="menuitem"
                onClick={go('/register')}
              >
                <Icon name="users" size={15} />
                Create an account
              </button>
            </>
          )}
        </div>
      )}

      <ChangePasswordDialog
        open={changingPassword}
        onClose={() => setChangingPassword(false)}
      />
    </div>
  )
}
