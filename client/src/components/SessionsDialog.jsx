import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { useToast } from './ui/useToast.js'
import { Modal } from './ui/Modal.jsx'
import { Button } from './ui/Button.jsx'
import { Icon } from './ui/Icon.jsx'
import { Skeleton } from './ui/Skeleton.jsx'
import { formatWhen } from '../lib/rooms.js'
import { describeDevice, isSessionActive } from '../lib/devices.js'

/**
 * What is signed in to this account, and how to sign it out.
 *
 * Until now revocation was all or nothing — changing the password ended every
 * session at once, and there was no way to see what those sessions were or to
 * end one of them. This is the surface for the per-session records that make
 * both possible.
 *
 * The row for the device you are reading it on is marked and has no sign-out
 * button. Without the marker the list is a row of indistinguishable browsers
 * and the obvious way to find out which is yours is to sign one out and see;
 * without withholding the button, the most likely misclick in the dialog is
 * the one that logs you out of it.
 */

function SessionsSkeleton() {
  return (
    <div className="people__list" aria-hidden="true">
      {[0, 1].map((row) => (
        <div className="people__list" key={row} style={{ padding: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Skeleton variant="circle" width={30} height={30} />
            <Skeleton width={`${50 + row * 15}%`} />
          </div>
        </div>
      ))}
    </div>
  )
}

function SessionRow({ session, busy, onRevoke }) {
  const active = isSessionActive(session)

  const detail = [
    session.current ? 'Active now' : active ? 'Active now' : 'Last active ' + formatWhen(session.lastSeenAt),
    session.ip || null,
    'Signed in ' + formatWhen(session.createdAt),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li>
      <span className={'people__avatar' + (session.current ? '' : ' people__avatar--muted')}>
        <Icon name="globe" size={15} />
      </span>

      <span className="people__who">
        <strong>{describeDevice(session.userAgent)}</strong>
        <span className="muted">{detail}</span>
      </span>

      {session.current ? (
        <span className="people__tag">This device</span>
      ) : (
        <Button
          size="sm"
          icon="close"
          loading={busy}
          onClick={onRevoke}
          title="Sign this device out"
        >
          Sign out
        </Button>
      )}
    </li>
  )
}

export function SessionsDialog({ open, onClose }) {
  const toast = useToast()

  const [state, setState] = useState('loading')
  const [sessions, setSessions] = useState([])
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(null)

  const load = useCallback(async (signal) => {
    setState('loading')
    setError(null)
    try {
      const payload = await api.sessions(signal)
      setSessions(payload.sessions)
      setState('ready')
    } catch (cause) {
      if (cause?.name === 'AbortError') return
      setError(cause.message)
      setState('error')
    }
  }, [])

  useEffect(() => {
    if (!open) return undefined
    // Re-read every time it opens: a device signed out from somewhere else
    // should not still be listed here.
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [open, load])

  const revoke = async (session) => {
    setPending(session.id)
    try {
      await api.revokeSession(session.id)
      setSessions((current) => current.filter((entry) => entry.id !== session.id))
      toast.success(describeDevice(session.userAgent) + ' signed out')
    } catch (cause) {
      toast.error(cause.message)
      // The list is no longer trustworthy if the server disagreed with it.
      load()
    } finally {
      setPending(null)
    }
  }

  const revokeOthers = async () => {
    setPending('others')
    try {
      const { revoked } = await api.revokeOtherSessions()
      setSessions((current) => current.filter((entry) => entry.current))
      toast.success(
        revoked === 0
          ? 'Nothing else was signed in'
          : revoked === 1
            ? 'One other device signed out'
            : revoked + ' other devices signed out'
      )
    } catch (cause) {
      toast.error(cause.message)
      load()
    } finally {
      setPending(null)
    }
  }

  const others = sessions.filter((session) => !session.current)

  return (
    <Modal
      open={open}
      title="Signed-in devices"
      description="Every browser holding a session for this account. Sign out anything you do not recognise."
      onClose={onClose}
      wide
    >
      {state === 'loading' && <SessionsSkeleton />}

      {state === 'error' && (
        <>
          <div className="banner banner--error" role="alert">
            <Icon name="alert" size={15} className="banner__icon" />
            <span>{error}</span>
          </div>
          <Button icon="redo" onClick={() => load()}>
            Try again
          </Button>
        </>
      )}

      {state === 'ready' && (
        <div className="people">
          <ul className="people__list">
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                busy={pending === session.id}
                onRevoke={() => revoke(session)}
              />
            ))}
          </ul>

          {/* Only reachable when the current session has somehow gone missing
              from its own list; worth saying something rather than nothing. */}
          {sessions.length === 0 && (
            <p className="people__empty">Nothing is signed in.</p>
          )}

          <p className="people__hint">
            {others.length === 0
              ? 'This is the only device signed in.'
              : others.length === 1
                ? 'One other device is signed in.'
                : others.length + ' other devices are signed in.'}{' '}
            Signing a device out closes its rooms straight away.
          </p>

          <div className="modal__actions">
            <Button onClick={onClose}>Close</Button>
            <Button
              variant="danger"
              icon="logOut"
              loading={pending === 'others'}
              disabled={others.length === 0}
              onClick={revokeOthers}
            >
              Sign out all other devices
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
