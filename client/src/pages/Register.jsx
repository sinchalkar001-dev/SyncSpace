import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth.js'
import { useToast } from '../components/ui/useToast.js'
import { AuthCard } from '../components/AuthCard.jsx'
import { Field } from '../components/ui/Field.jsx'
import { Button } from '../components/ui/Button.jsx'
import { Icon } from '../components/ui/Icon.jsx'
import { PasswordStrength } from '../components/ui/PasswordStrength.jsx'
import { validateRegistration } from '../lib/validation.js'

export default function Register() {
  const { register, isAuthenticated, isLoading } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)

  if (!isLoading && isAuthenticated) return <Navigate to="/dashboard" replace />

  const update = (key) => (event) => {
    const { value } = event.target
    setForm((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
    setFormError(null)
  }

  const onSubmit = async (event) => {
    event.preventDefault()
    setFormError(null)

    const found = validateRegistration(form)
    setErrors(found)
    if (Object.keys(found).length > 0) return

    setBusy(true)
    try {
      const user = await register({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
      })
      toast.success('Account created — welcome, ' + user.name)
      navigate('/dashboard', { replace: true })
    } catch (cause) {
      setFormError(cause.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard
      title="Create an account"
      subtitle="Keep your rooms, invite teammates, and replay past sessions."
      footer={
        <>
          <span>
            Already registered? <Link to="/login">Sign in</Link>
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

        <Field
          label="Display name"
          value={form.name}
          onChange={update('name')}
          autoComplete="nickname"
          placeholder="How teammates will see you"
          icon="users"
          error={errors.name}
          maxLength={32}
          showCount
        />

        <Field
          label="Email"
          type="email"
          value={form.email}
          onChange={update('email')}
          autoComplete="email"
          placeholder="you@company.com"
          icon="inbox"
          error={errors.email}
        />

        <Field
          label="Password"
          type="password"
          value={form.password}
          onChange={update('password')}
          autoComplete="new-password"
          placeholder="At least 8 characters"
          icon="lock"
          error={errors.password}
          hint="At least 8 characters."
        >
          <PasswordStrength password={form.password} />
        </Field>

        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Create account
        </Button>
      </form>
    </AuthCard>
  )
}
