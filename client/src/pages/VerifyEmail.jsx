import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAuth } from '../auth/useAuth.js'
import { Icon } from '../components/ui/Icon.jsx'
import { Button } from '../components/ui/Button.jsx'
import { Spinner } from '../components/ui/Spinner.jsx'

/**
 * Proving an address, whichever way the person came at it.
 *
 * Three arrivals land here and they are genuinely different situations, which
 * is why one page handles all of them rather than three pages sharing a name:
 *
 *   ?token=…    the link, spent on arrival — nothing to type
 *   ?status=…   the server already spent it and redirected here to say so
 *   no params   "check your email": the code, the resend, the countdown
 *
 * The third is the one people actually use when the email is on their phone
 * and SyncSpace is open on a laptop.
 *
 * Nothing here decides anything. Every state on this page comes from what the
 * server answered — a client that decided for itself whether an address was
 * verified would be deciding the one thing it must not.
 */

const CODE_LENGTH = 6

export default function VerifyEmail() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const redirected = params.get('status')

  const { isAuthenticated, refresh } = useAuth()

  const initial = token ? 'verifying' : redirected === 'verified' ? 'verified' : redirected === 'invalid' ? 'invalid' : 'waiting'

  const [state, setState] = useState(initial)
  const [error, setError] = useState(null)
  const [code, setCode] = useState('')
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState(null)
  const [resending, setResending] = useState(false)
  const [cooldown, setCooldown] = useState(0)

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

  /**
   * How long is left, and how many guesses — read from the server rather than
   * assumed, so a page reloaded halfway through a cooldown shows the truth
   * instead of starting the wait again.
   */
  useEffect(() => {
    if (token || !isAuthenticated) return undefined

    const controller = new AbortController()
    api.verificationStatus(controller.signal).then(
      (payload) => {
        setStatus(payload)
        setCooldown(payload.retryAfter ?? 0)
        if (payload.emailVerified) setState('verified')
      },
      () => {}
    )
    return () => controller.abort()
  }, [token, isAuthenticated])

  // The countdown, so "resend" is not a button that silently refuses.
  useEffect(() => {
    if (cooldown <= 0) return undefined
    const timer = setTimeout(() => setCooldown((left) => left - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const submitCode = useCallback(
    async (event) => {
      event?.preventDefault()
      if (code.length !== CODE_LENGTH || checking) return

      setChecking(true)
      setError(null)

      try {
        await api.verifyEmailCode({ code })
        setState('verified')
        refresh?.()
      } catch (cause) {
        setError(cause.message)
        // The server distinguishes these; the page should too, because the way
        // out of each is different — retype, or ask for a new email.
        if (cause.code === 'too_many_attempts' || cause.code === 'code_expired') {
          setState('spent')
        }
        setCode('')
      } finally {
        setChecking(false)
      }
    },
    [code, checking, refresh]
  )

  const resend = useCallback(async () => {
    setResending(true)
    setError(null)

    try {
      const answer = await api.resendVerification()
      setCooldown(answer?.retryAfter ?? 60)
      setState('waiting')
      setCode('')
    } catch (cause) {
      setError(cause.message)
      if (typeof cause.retryAfter === 'number') setCooldown(cause.retryAfter)
    } finally {
      setResending(false)
    }
  }, [])

  const icon = state === 'verified' ? 'checkCircle' : state === 'waiting' ? 'mail' : 'alert'

  return (
    <main className="gate" id="main">
      <div className="gate__card">
        <span className="empty__icon" style={{ margin: '0 auto var(--space-4)' }}>
          {state === 'verifying' ? (
            <Spinner size="lg" label="Confirming your email" />
          ) : (
            <Icon name={icon} size={22} />
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

        {(state === 'waiting' || state === 'spent') && (
          <>
            <h1>Check your email</h1>
            <p>
              {status?.email ? (
                <>
                  We sent a verification email to <strong>{status.email}</strong>.
                </>
              ) : (
                'We sent you a verification email.'
              )}
            </p>
            <p className="muted">
              Enter the {CODE_LENGTH}-digit code from it, or open the link in the same email.
            </p>

            <form onSubmit={submitCode} className="verify__form">
              <label className="field">
                <span className="field__label">Verification code</span>
                <input
                  className="input verify__code"
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))
                  }
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  aria-label="Verification code"
                  disabled={state === 'spent'}
                />
              </label>

              {error && (
                <div className="banner banner--error" role="alert">
                  <Icon name="alert" size={15} className="banner__icon" />
                  <span>{error}</span>
                </div>
              )}

              <div className="gate__actions">
                <Button
                  type="submit"
                  variant="primary"
                  loading={checking}
                  disabled={code.length !== CODE_LENGTH || state === 'spent'}
                >
                  Verify email
                </Button>

                {/* Disabled with the wait on it, rather than hidden: a button
                    that vanishes reads as broken, one that counts down reads
                    as a rule. */}
                <Button
                  variant="ghost"
                  icon="redo"
                  loading={resending}
                  disabled={cooldown > 0 || !isAuthenticated}
                  onClick={resend}
                >
                  {cooldown > 0 ? 'Resend in ' + cooldown + 's' : 'Resend email'}
                </Button>
              </div>
            </form>

            {!isAuthenticated && (
              <p className="muted">
                <Link to="/login">Sign in</Link> to have another email sent.
              </p>
            )}
          </>
        )}

        {state === 'invalid' && (
          <>
            <h1>That link did not work</h1>
            <p>{error || 'This verification link is invalid or has expired.'}</p>
            <p className="muted">
              Links can only be used once, and they expire. If you have already confirmed this
              address, you are done — just sign in.
            </p>

            <div className="gate__actions">
              {isAuthenticated ? (
                <Button variant="primary" loading={resending} icon="redo" onClick={resend} disabled={cooldown > 0}>
                  {cooldown > 0 ? 'Resend in ' + cooldown + 's' : 'Send a new email'}
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
