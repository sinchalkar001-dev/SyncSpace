import { useState } from 'react'
import { Button } from './ui/Button.jsx'

/**
 * The pieces a roster is made of, shared by the dashboard dialog and the
 * presence popover in the room so the same person looks the same in both.
 */

export function Avatar({ name, color, muted }) {
  return (
    <span
      className={muted ? 'people__avatar people__avatar--muted' : 'people__avatar'}
      style={color ? { background: color, color: 'var(--accent-ink)' } : undefined}
    >
      {String(name || '?')
        .slice(0, 1)
        .toUpperCase()}
    </span>
  )
}

/**
 * One person: who they are, what they are, and the single thing the owner can
 * do about them. `action` is left off entirely for anyone looking at a room
 * they do not own, which is what keeps the list readable for everybody else.
 */
export function PersonRow({ name, detail, tag, color, muted, action }) {
  return (
    <li>
      <Avatar name={name} color={color} muted={muted} />

      <span className="people__who">
        <strong>{name}</strong>
        {detail && <span className="muted">{detail}</span>}
      </span>

      {tag && <span className="people__tag">{tag}</span>}

      {action && (
        <Button
          size="sm"
          variant={action.variant || 'ghost'}
          icon={action.icon}
          loading={action.loading}
          disabled={action.disabled}
          onClick={action.onClick}
          title={action.title}
        >
          {action.label}
        </Button>
      )}
    </li>
  )
}

/**
 * Invite by email address, because that is what the owner of a room actually
 * knows about the person they are waiting for. The field keeps its value when
 * the address is refused — a typo is worth correcting, not retyping.
 */
export function InviteForm({ onInvite, pending, hint }) {
  const [email, setEmail] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    const address = email.trim()
    if (!address || pending) return
    if (await onInvite(address)) setEmail('')
  }

  return (
    <form className="people__invite" onSubmit={submit}>
      <input
        className="input"
        type="email"
        inputMode="email"
        autoComplete="off"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="name@example.com"
        aria-label="Email address to invite"
        required
      />
      <Button type="submit" variant="primary" icon="plus" loading={pending}>
        Invite
      </Button>
      {hint && <p className="people__hint">{hint}</p>}
    </form>
  )
}
