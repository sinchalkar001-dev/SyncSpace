import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAuth } from '../auth/useAuth.js'
import { useToast } from '../components/ui/useToast.js'
import { UserMenu } from '../components/UserMenu.jsx'
import { Spinner } from '../components/ui/Spinner.jsx'

function formatWhen(value) {
  if (!value) return 'never'
  const then = new Date(value)
  const minutes = Math.round((Date.now() - then.getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return minutes + 'm ago'
  if (minutes < 1440) return Math.round(minutes / 60) + 'h ago'
  return then.toLocaleDateString()
}

export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  const [rooms, setRooms] = useState([])
  const [state, setState] = useState('loading')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback((signal) => {
    setState('loading')
    return api
      .listRooms(signal)
      .then((payload) => {
        setRooms(payload.rooms)
        setState('ready')
      })
      .catch((error) => {
        if (error?.name === 'AbortError') return
        setState('error')
      })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  const onCreate = async (event) => {
    event.preventDefault()
    setCreating(true)
    try {
      const { room } = await api.createRoom({ name: name.trim() || undefined })
      toast.success('Room created')
      navigate('/room/' + room.roomId)
    } catch (error) {
      toast.error(error.message)
    } finally {
      setCreating(false)
    }
  }

  const onJoin = (event) => {
    event.preventDefault()
    const trimmed = code.trim()
    if (trimmed) navigate('/room/' + encodeURIComponent(trimmed))
  }

  return (
    <div className="shell">
      <header className="shell__bar">
        <span className="shell__brand">
          <span className="brand-mark">SS</span>
          SyncSpace
        </span>
        <div className="shell__right">
          <UserMenu />
        </div>
      </header>

      <main className="dashboard">
        <div className="dashboard__intro">
          <h1>Hello, {user?.name}</h1>
          <p>Start a session, or pick up where you left off.</p>
        </div>

        <div className="dashboard__actions">
          <form className="panel" onSubmit={onCreate}>
            <h2 className="panel__title">Start a room</h2>
            <p className="panel__hint">Private by default. Invite people from inside the room.</p>
            <div className="panel__row">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Room name (optional)"
                aria-label="Room name"
                maxLength={80}
              />
              <button type="submit" className="btn btn--primary" disabled={creating}>
                {creating ? <Spinner label="Creating" /> : 'Create'}
              </button>
            </div>
          </form>

          <form className="panel" onSubmit={onJoin}>
            <h2 className="panel__title">Join with a code</h2>
            <p className="panel__hint">Paste the code a teammate shared with you.</p>
            <div className="panel__row">
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Room code"
                aria-label="Room code"
              />
              <button type="submit" className="btn" disabled={!code.trim()}>
                Join
              </button>
            </div>
          </form>
        </div>

        <section className="dashboard__rooms" aria-labelledby="your-rooms">
          <div className="dashboard__rooms-head">
            <h2 id="your-rooms">Your rooms</h2>
            {state === 'ready' && rooms.length > 0 && (
              <span className="muted">{rooms.length} total</span>
            )}
          </div>

          {state === 'loading' && (
            <div className="placeholder">
              <Spinner label="Loading your rooms" />
            </div>
          )}

          {state === 'error' && (
            <div className="placeholder placeholder--error" role="alert">
              <p>Could not load your rooms.</p>
              <button type="button" className="btn" onClick={() => load()}>
                Retry
              </button>
            </div>
          )}

          {state === 'ready' && rooms.length === 0 && (
            <div className="placeholder">
              <p>No rooms yet. Create one above and share the link.</p>
            </div>
          )}

          {state === 'ready' && rooms.length > 0 && (
            <ul className="roomlist">
              {rooms.map((room) => (
                <li key={room.roomId}>
                  <button
                    type="button"
                    className="roomlist__item"
                    onClick={() => navigate('/room/' + room.roomId)}
                  >
                    <span className="roomlist__name">{room.name}</span>
                    <span className="roomlist__meta">
                      <code>{room.roomId}</code>
                      <span>{room.isPublic ? 'Public' : 'Private'}</span>
                      <span>{room.memberCount} member{room.memberCount === 1 ? '' : 's'}</span>
                      <span>Active {formatWhen(room.lastActivityAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}
