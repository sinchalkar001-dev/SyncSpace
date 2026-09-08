import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAuth } from '../auth/useAuth.js'
import { Icon } from '../components/ui/Icon.jsx'
import { Button } from '../components/ui/Button.jsx'
import { Spinner } from '../components/ui/Spinner.jsx'

/**
 * Redeeming a room invitation.
 *
 * The person arriving here has followed a link from their email and may be in
 * any of four states: signed in and verified, signed in but unverified, signed
 * in as somebody else, or not signed in at all. Each needs a different next
 * step, and getting that wrong means showing somebody a button that cannot
 * work and a refusal they cannot act on.
 *
 * What the room is, is shown before anything is asked of them. Somebody who
 * has to sign up first deserves to know what they are signing up for — and the
 * server tells us only the room's name and who invited them, never who else is
 * in it.
 */
export default function AcceptInvitation() {
  const [params] = useSearchParams()
  const token = params.get('token')

  const { isAuthenticated, user, isLoading } = useAuth()
  const navigate = useNavigate()

  const [state, setState] = useState(token ? 'loading' : 'missing')
  const [invitation, setInvitation] = useState(null)
  const [error, setError] = useState(null)
  const [accepting, setAccepting] = useState(false)

  useEffect(() => {
    if (!token) return undefined

    const controller = new AbortController()
    api.invitation(token, controller.signal).then(
      (payload) => {
        setInvitation(payload.invitation)
        setState('ready')
      },
      (cause) => {
        if (cause?.name === 'AbortError') return
        setError(cause.message)
        setState('invalid')
      }
    )
    return () => controller.abort()
  }, [token])

  const accept = useCallback(async () => {
    setAccepting(true)
    setError(null)

    try {
      const payload = await api.acceptInvitation(token)
      navigate('/room/' + payload.room.roomId)
    } catch (cause) {
      setError(cause.message)

      /**
       * The two refusals a person can actually do something about.
       *
       * Everything else — spent, expired, sent to another address — is the
       * same flat "invalid" from the server, deliberately: telling somebody
       * holding a forwarded link which address it was meant for is exactly
       * what the binding is protecting.
       */
      if (cause.code === 'email_not_verified') setState('unverified')
      else if (cause.code === 'invitation_invalid') setState('invalid')
      setAccepting(false)
    }
  }, [token, navigate])

  if (isLoading) {
    return (
      <main className="gate" id="main">
        <div className="gate__card">
          <Spinner size="lg" label="Loading" />
        </div>
      </main>
    )
  }

  return (
    <main className="gate" id="main">
      <div className="gate__card">
        <span className="empty__icon" style={{ margin: '0 auto var(--space-4)' }}>
          {state === 'loading' ? (
            <Spinner size="lg" label="Reading your invitation" />
          ) : (
            <Icon name={state === 'ready' ? 'mail' : 'alert'} size={22} />
          )}
        </span>

        {state === 'loading' && (
          <>
            <h1>Reading your invitation</h1>
            <p className="muted">One moment.</p>
          </>
        )}

        {state === 'missing' && (
          <>
            <h1>Nothing to accept</h1>
            <p>This page needs the link from your invitation email.</p>
            <div className="gate__actions">
              <Link className="btn btn--primary" to="/dashboard">
                My rooms
              </Link>
            </div>
          </>
        )}

        {state === 'ready' && invitation && (
          <>
            <h1>
              {invitation.invitedBy
                ? invitation.invitedBy + ' invited you'
                : 'You have been invited'}
            </h1>
            <p>
              to collaborate in <strong>{invitation.roomName}</strong>
              {invitation.role ? ' as a ' + invitation.role : ''}.
            </p>

            {error && (
              <div className="banner banner--error" role="alert">
                <Icon name="alert" size={15} className="banner__icon" />
                <span>{error}</span>
              </div>
            )}

            {isAuthenticated ? (
              <>
                <div className="gate__actions">
                  <Button variant="primary" loading={accepting} onClick={accept}>
                    Join room
                  </Button>
                </div>
                <p className="muted">
                  Joining as {user?.email}. The invitation was sent to one address — if that is
                  not this one, sign in with the address it reached.
                </p>
              </>
            ) : (
              <>
                {/* The invitation is bound to an address, so signing up with
                    the right one is not a detail — it is the whole thing. */}
                <p className="muted">
                  Create an account with the address this invitation was sent to, or sign in if
                  you already have one. Your invitation will be waiting.
                </p>
                <div className="gate__actions">
                  <Link className="btn btn--primary" to="/register">
                    Create an account
                  </Link>
                  <Link className="btn" to="/login">
                    Sign in
                  </Link>
                </div>
              </>
            )}
          </>
        )}

        {state === 'unverified' && (
          <>
            <h1>Verify your email first</h1>
            <p>
              An invitation is not a way around confirming your address. Verify it, then come
              back to this link.
            </p>
            <div className="gate__actions">
              <Link className="btn btn--primary" to="/verify-email">
                Verify my email
              </Link>
            </div>
          </>
        )}

        {state === 'invalid' && (
          <>
            <h1>That invitation did not work</h1>
            <p>{error || 'This invitation is invalid or has expired.'}</p>
            <p className="muted">
              Invitations expire, can only be used once, and only work for the address they were
              sent to. Ask whoever invited you to send another.
            </p>
            <div className="gate__actions">
              <Link className="btn btn--primary" to="/dashboard">
                My rooms
              </Link>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
