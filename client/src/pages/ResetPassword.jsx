import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAuth } from '../auth/useAuth.js'
import { useToast } from '../components/ui/useToast.js'
import { AuthCard } from '../components/AuthCard.jsx'
import { Field } from '../components/ui/Field.jsx'
import { Button } from '../components/ui/Button.jsx'
import { Icon } from '../components/ui/Icon.jsx'
import { PasswordStrength } from '../components/ui/PasswordStrength.jsx'
import { MIN_PASSWORD } from '../lib/validation.js'

/**
 * Where every reset email points.
 *
 * Unlike the confirmation page next door, the token is not spent on arrival:
 * it is single-use and there is a form to fill in first, so spending it before
 * the person has typed anything would burn the link on a page view. It is
 * carried in the URL and submitted with the new password.
 *
 * The link is an hour old at most but expires, and an expired one is the
 * common way to land here in a bad state — so that case leads somewhere
 * useful rather than just apologising.
 */
export default function ResetPassword() {
  const [params] = useSearchParams()
  const token = params.get('token')

  const { adopt } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  const [form, setForm] = useState({ password: '', confirmPassword: '' })
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)

  const update = (key) => (event) => {
    const { value } = event.target
    setForm((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
    setFormError(null)
  }

  const validate = () => {
    const found = {}
    if (form.password.length < MIN_PASSWORD) {
      found.password = 'Use at least ' + MIN_PASSWORD + ' characters.'
    }
    if (form.confirmPassword !== form.password) {
      found.confirmPassword = 'These do not match.'
    }
    return found
  }

  const onSubmit = async (event) => {
    event.preventDefault()
    setFormError(null)

    const found = validate()
    setErrors(found)
    if (Object.keys(found).length > 0) return

    setBusy(true)
    try {
      // Answers a session, because the emailed token proved the address and
      // the password was just chosen here.
      const user = adopt(await api.resetPassword(token, form.password))
      toast.success('Password updated. Welcome back, ' + user.name)
      navigate('/dashboard', { replace: true })
    } catch (cause) {
      setFormError(cause.message)
    } finally {
      setBusy(false)
    }
  }

  // Nothing to spend: someone opened the page directly, or a mail client
  // mangled the link on the way.
  if (!token) {
    return (
      <AuthCard
        title="Nothing to reset"
        subtitle="This page needs the link from your reset email."
        footer={
          <span>
            Remembered it? <Link to="/login">Sign in</Link>
          </span>
        }
      >
        <div className="banner banner--error" role="alert">
          <Icon name="alert" size={15} className="banner__icon" />
          <span>That link is missing its token.</span>
        </div>

        <p className="muted">
          Open the email and use the link in it, or ask for a new one.
        </p>

        <Link className="btn btn--primary btn--block" to="/forgot-password">
          Send a new link
        </Link>
      </AuthCard>
    )
  }

  // A dead link is the expected failure here, not an exceptional one: they
  // last an hour, are single-use, and asking again replaces the last one. The
  // way out is one button, not an apology.
  const linkIsDead = formError && /invalid or has expired/i.test(formError)

  return (
    <AuthCard
      title="Choose a new password"
      subtitle="This signs you in on this device once it is saved."
      footer={
        <>
          <span>
            Remembered it? <Link to="/login">Sign in</Link>
          </span>
          <Link to="/">Continue as a guest</Link>
        </>
      }
    >
      <form className="auth__form" onSubmit={onSubmit} noValidate>
        {formError && (
          <div className="banner banner--error" role="alert">
            <Icon name="alert" size={15} className="banner__icon" />
            <span>{formError}</span>
          </div>
        )}

        {linkIsDead && (
          <p className="muted">
            Reset links last an hour and can only be used once.{' '}
            <Link to="/forgot-password">Ask for a new one</Link>.
          </p>
        )}

        <Field
          label="New password"
          type="password"
          value={form.password}
          onChange={update('password')}
          error={errors.password}
          autoComplete="new-password"
          icon="lock"
          hint={'At least ' + MIN_PASSWORD + ' characters.'}
          required
        >
          <PasswordStrength password={form.password} />
        </Field>

        <Field
          label="Confirm new password"
          type="password"
          value={form.confirmPassword}
          onChange={update('confirmPassword')}
          error={errors.confirmPassword}
          autoComplete="new-password"
          icon="lock"
          required
        />

        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Save and sign in
        </Button>
      </form>
    </AuthCard>
  )
}
