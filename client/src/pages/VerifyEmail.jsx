import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAuth } from '../auth/useAuth.js'
import { Icon } from '../components/ui/Icon.jsx'
import { Button } from '../components/ui/Button.jsx'
import { Spinner } from '../components/ui/Spinner.jsx'

/**
 * The page every verification email has always pointed at.
 *
 * The link is built as CLIENT_URL + '/verify-email?token=...' and the route
 * did not exist, so confirming an address landed on "Nothing here" — for every
 * account ever created. The token is spent on arrival, which is the whole
 * interaction: there is nothing to type and nothing to submit.
 */
export default function VerifyEmail() {
  const [params] = useSearchParams()
  const token = params.get('token')

  const { isAuthenticated, refresh } = useAuth()
  const [state, setState] = useState(token ? 'verifying' : 'missing')
  const [error, setError] = useState(null)
  const [resent, setResent] = useState(false)
  const [resending, setResending] = useState(false)

  // A token is single-use, so React's development double-effect must not spend
  // it twice — the second attempt would report a perfectly good link as dead.
  const attempted = useRef(false)

  useEffect(() => {
    if (!token || attempted.current) return
    attempted.current = true

    api.verifyEmail(token).then(
      () => {
        setState('verified')
        // The session in memory still says unverified; make it agree.
        refresh?.()
      },
      (cause) => {
        setError(cause.message)
        setState('invalid')
      }
    )
  }, [token, refresh])

  const resend = useCallback(async () => {
    setResending(true)
    try {
      await api.resendVerification()
      setResent(true)
    } catch (cause) {
      setError(cause.message)
    } finally {
      setResending(false)
    }
  }, [])

  return (
    <main className="gate" id="main">
      <div className="gate__card">
        <span className="empty__icon" style={{ margin: '0 auto var(--space-4)' }}>
          {state === 'verifying' ? (
            <Spinner size="lg" label="Confirming your email" />
          ) : (
            <Icon name={state === 'verified' ? 'checkCircle' : 'alert'} size={22} />
          )}
        </span>

        {state === 'verifying' && (
          <>
            <h1>Confirming your email</h1>
            <p className="muted">One moment.</p>
          </>
        )}

        {state === 'verified' && (
          <>
            <h1>Email confirmed</h1>
            <p>Your address is verified. Nothing else to do.</p>
            <div className="gate__actions">
              <Link className="btn btn--primary" to="/dashboard">
                Go to your rooms
              </Link>
            </div>
          </>
        )}

        {state === 'missing' && (
          <>
            <h1>Nothing to confirm</h1>
            <p>This page needs the link from your confirmation email.</p>
            <p className="muted">Open the email and use the link in it.</p>
            <div className="gate__actions">
              <Link className="btn btn--primary" to="/dashboard">
                My rooms
              </Link>
            </div>
          </>
        )}

        {state === 'invalid' && (
          <>
            <h1>That link did not work</h1>
            <p>{error}</p>
            <p className="muted">
              Confirmation links last 24 hours and can only be used once. If you have already
              confirmed this address, you are done — just sign in.
            </p>

            {resent && (
              <div className="banner" role="status">
                <Icon name="checkCircle" size={15} className="banner__icon" />
                <span>A new confirmation email is on its way.</span>
              </div>
            )}

            <div className="gate__actions">
              {isAuthenticated && !resent ? (
                <Button variant="primary" loading={resending} icon="redo" onClick={resend}>
                  Send a new link
                </Button>
              ) : (
                <Link className="btn btn--primary" to="/login">
                  Sign in
                </Link>
              )}
              <Link className="btn" to="/dashboard">
                My rooms
              </Link>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
