import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth.js'
import { useToast } from '../components/ui/useToast.js'
import { AuthCard } from '../components/AuthCard.jsx'
import { Field } from '../components/ui/Field.jsx'
import { Button } from '../components/ui/Button.jsx'
import { Icon } from '../components/ui/Icon.jsx'

export default function Login() {
  const { login, isAuthenticated, isLoading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()

  const redirectTo = location.state?.from || '/dashboard'
  const [form, setForm] = useState({ email: '', password: '' })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  if (!isLoading && isAuthenticated) return <Navigate to={redirectTo} replace />

  const update = (key) => (event) => {
    const { value } = event.target
    setForm((current) => ({ ...current, [key]: value }))
    // Clear a stale server error as soon as the user changes anything.
    setError(null)
  }

  const onSubmit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const user = await login(form)
      toast.success('Welcome back, ' + user.name)
      navigate(redirectTo, { replace: true })
    } catch (cause) {
      setError(cause.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard
      title="Sign in"
      subtitle="Your rooms and their history follow your account."
      footer={
        <>
          <span>
            No account? <Link to="/register">Create one</Link>
          </span>
          <Link to="/">Continue as a guest</Link>
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
          value={form.email}
          onChange={update('email')}
          autoComplete="email"
          placeholder="you@company.com"
          icon="inbox"
          required
        />

        <Field
          label="Password"
          type="password"
          value={form.password}
          onChange={update('password')}
          autoComplete="current-password"
          placeholder="Your password"
          icon="lock"
          required
        />

        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  )
}
