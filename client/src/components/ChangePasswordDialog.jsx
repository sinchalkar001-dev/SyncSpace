import { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { useToast } from './ui/useToast.js'
import { Modal } from './ui/Modal.jsx'
import { Field } from './ui/Field.jsx'
import { Button } from './ui/Button.jsx'
import { Icon } from './ui/Icon.jsx'
import { PasswordStrength } from './ui/PasswordStrength.jsx'
import { MIN_PASSWORD } from '../lib/validation.js'

const EMPTY = { currentPassword: '', newPassword: '', confirmPassword: '' }

/**
 * Changes the signed-in account's password.
 *
 * The server has accepted `POST /api/auth/change-password` since the backend
 * merge, but nothing in the client called it — this is the missing surface for
 * an endpoint that already exists, not new behaviour.
 */
export function ChangePasswordDialog({ open, onClose }) {
  const toast = useToast()

  const [form, setForm] = useState(EMPTY)
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setForm(EMPTY)
      setErrors({})
      setFormError(null)
    }
  }, [open])

  const update = (key) => (event) => {
    const { value } = event.target
    setForm((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
  }

  const validate = () => {
    const found = {}
    if (!form.currentPassword) found.currentPassword = 'Enter your current password.'
    if (form.newPassword.length < MIN_PASSWORD) {
      found.newPassword = 'Use at least ' + MIN_PASSWORD + ' characters.'
    } else if (form.newPassword === form.currentPassword) {
      found.newPassword = 'Choose a password you have not used here before.'
    }
    if (form.confirmPassword !== form.newPassword) {
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
      await api.changePassword({
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      })
      toast.success('Password updated')
      onClose()
    } catch (cause) {
      setFormError(cause.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="Change password"
      description="You stay signed in on this device. Other sessions keep their existing tokens until those expire."
      onClose={onClose}
    >
      <form onSubmit={onSubmit} noValidate>
        {formError && (
          <div className="banner banner--error" role="alert">
            <Icon name="alert" size={15} className="banner__icon" />
            <span>{formError}</span>
          </div>
        )}

        <Field
          label="Current password"
          type="password"
          value={form.currentPassword}
          onChange={update('currentPassword')}
          error={errors.currentPassword}
          autoComplete="current-password"
        />

        <Field
          label="New password"
          type="password"
          value={form.newPassword}
          onChange={update('newPassword')}
          error={errors.newPassword}
          autoComplete="new-password"
          hint={'At least ' + MIN_PASSWORD + ' characters.'}
        >
          <PasswordStrength password={form.newPassword} />
        </Field>

        <Field
          label="Confirm new password"
          type="password"
          value={form.confirmPassword}
          onChange={update('confirmPassword')}
          error={errors.confirmPassword}
          autoComplete="new-password"
        />

        <div className="modal__actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            Update password
          </Button>
        </div>
      </form>
    </Modal>
  )
}
