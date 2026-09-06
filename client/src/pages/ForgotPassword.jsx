import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client.js'
import { AuthCard } from '../components/AuthCard.jsx'
import { Field } from '../components/ui/Field.jsx'
import { Button } from '../components/ui/Button.jsx'
import { Icon } from '../components/ui/Icon.jsx'

/**
 * Asking for a reset link.
 *
 * The screen never says whether the address has an account, because the server
 * refuses to say — answering `{ sent: true }` either way is what stops this
 * public route from being a way to test which addresses are registered. That
 * discipline is easy to undo from here by mistake, so it is worth being
 * explicit: there is no "no account with that address" branch below, and there
 * must not be one. The confirmation is phrased to be honest about it rather
 * than implying an email is definitely on its way.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.forgotPassword(email.trim())
      setSent(true)
    } catch (cause) {
      // Only ever a real failure — rate limiting, a malformed address, or an
      // unreachable server. Never "we could not find you".
      setError(cause.message)
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <AuthCard
        title="Check your email"
        subtitle="If that address has an account, a reset link is on its way."
        footer={
          <>
            <span>
              Remembered it? <Link to="/login">Sign in</Link>
            </span>
            <Link to="/">Continue as a guest</Link>
          </>
        }
      >
        <div className="banner" role="status">
          <Icon name="checkCircle" size={15} className="banner__icon" />
          <span>We sent it to {email.trim()} if an account is registered there.</span>
        </div>

        <p className="muted">
          The link lasts an hour and can be used once. If nothing arrives, check the spam folder,
          then try again — asking a second time replaces the first link.
        </p>

        <Button block onClick={() => setSent(false)} icon="redo">
          Use a different address
        </Button>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="We will email you a link to choose a new one."
      footer={
        <>
          <span>
            Remembered it? <Link to="/login">Sign in</Link>
          </span>
          <Link to="/register">Create an account</Link>
        </>
      }
    >
      <form className="auth__form" onSubmit={onSubmit} noValidate>
        {error && (
          <div className="banner banner--error" role="alert">
            <Icon name="alert" size={15} className="banner__icon" />
            <span>{error}</span>
          </div>
        )}

        <Field
          label="Email"
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
            setError(null)
          }}
          autoComplete="email"
          placeholder="you@company.com"
          icon="inbox"
          hint="The address you signed up with."
          required
        />

        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Email me a reset link
        </Button>
      </form>
    </AuthCard>
  )
}
