import { useState } from 'react'
import { useAuth } from '../auth/useAuth.js'
import { useToast } from './ui/useToast.js'
import { api } from '../api/client.js'
import { Button } from './ui/Button.jsx'
import { Icon } from './ui/Icon.jsx'

/**
 * The only way to ask for another confirmation email.
 *
 * The endpoint has always existed and nothing in the app ever called it, so an
 * expired link or an email that never arrived was a dead end. It shows only
 * while the signed-in account is unverified, and disappears the moment it is
 * not needed — nothing is gated on verification, so this informs rather than
 * blocks.
 */
export function VerifyEmailNotice() {
  const { user, isAuthenticated } = useAuth()
  const toast = useToast()
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  if (!isAuthenticated || !user || user.emailVerified) return null

  const resend = async () => {
    setSending(true)
    try {
      await api.resendVerification()
      setSent(true)
      toast.success('Confirmation email sent to ' + user.email)
    } catch (error) {
      toast.error(error.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="banner" role="status">
      <Icon name="inbox" size={15} className="banner__icon" />

      <span style={{ flex: 1 }}>
        {sent ? (
          <>A new confirmation link is on its way to <strong>{user.email}</strong>.</>
        ) : (
          <>
            Confirm <strong>{user.email}</strong> using the link we emailed you.
          </>
        )}
      </span>

      {!sent && (
        <Button size="sm" icon="redo" loading={sending} onClick={resend}>
          Resend
        </Button>
      )}
    </div>
  )
}
