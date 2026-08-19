import { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { Modal } from './ui/Modal.jsx'
import { Spinner } from './ui/Spinner.jsx'

function formatWhen(value) {
  if (!value) return 'never'
  const then = new Date(value)
  const minutes = Math.round((Date.now() - then.getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return minutes + 'm ago'
  if (minutes < 1440) return Math.round(minutes / 60) + 'h ago'
  return then.toLocaleDateString()
}

function Avatar({ name, muted }) {
  return (
    <span className={muted ? 'people__avatar people__avatar--muted' : 'people__avatar'}>
      {String(name || '?')
        .slice(0, 1)
        .toUpperCase()}
    </span>
  )
}

/**
 * Who can reach a room, and who actually has.
 *
 * "Members" are the owner plus anyone invited; "Opened this room" is drawn
 * from real visits, so it includes guests who never had an account.
 */
export function RoomPeopleDialog({ room, open, onClose }) {
  const [state, setState] = useState('loading')
  const [people, setPeople] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open || !room) return undefined

    const controller = new AbortController()
    setState('loading')
    setError(null)

    api
      .roomPeople(room.roomId, controller.signal)
      .then((payload) => {
        setPeople(payload)
        setState('ready')
      })
      .catch((cause) => {
        if (cause?.name === 'AbortError') return
        setError(cause.message)
        setState('error')
      })

    return () => controller.abort()
  }, [open, room])

  return (
    <Modal
      open={open}
      title={room ? 'People in ' + room.name : 'People'}
      description={room ? 'Room ' + room.roomId : undefined}
      onClose={onClose}
    >
      {state === 'loading' && (
        <div className="people__placeholder">
          <Spinner label="Loading people" />
        </div>
      )}

      {state === 'error' && (
        <div className="banner banner--error" role="alert">
          {error}
        </div>
      )}

      {state === 'ready' && people && (
        <div className="people">
          <section>
            <h3 className="people__heading">Members</h3>
            <ul className="people__list">
              {people.members.map((member) => (
                <li key={member.id}>
                  <Avatar name={member.name} />
                  <span className="people__who">
                    <strong>{member.name}</strong>
                    <span className="muted">{member.email}</span>
                  </span>
                  <span className="people__tag">{member.role}</span>
                </li>
              ))}
              {people.members.length === 0 && (
                <li className="muted people__empty">Nobody has been invited yet.</li>
              )}
            </ul>
          </section>

          <section>
            <h3 className="people__heading">Opened this room</h3>
            <ul className="people__list">
              {people.participants.map((person) => (
                <li key={person.id}>
                  <Avatar name={person.name} muted={person.guest} />
                  <span className="people__who">
                    <strong>{person.name}</strong>
                    <span className="muted">
                      {person.visits} visit{person.visits === 1 ? '' : 's'} · last{' '}
                      {formatWhen(person.lastSeenAt)}
                    </span>
                  </span>
                  {person.guest && <span className="people__tag">guest</span>}
                </li>
              ))}
              {people.participants.length === 0 && (
                <li className="muted people__empty">Nobody has opened this room yet.</li>
              )}
            </ul>
          </section>
        </div>
      )}

      <div className="modal__actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
