import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAuth } from '../auth/useAuth.js'
import { useToast } from '../components/ui/useToast.js'
import { UserMenu } from '../components/UserMenu.jsx'
import { RoomCard } from '../components/RoomCard.jsx'
import { RoomPeopleDialog } from '../components/RoomPeopleDialog.jsx'
import { ConfirmDialog } from '../components/ui/Modal.jsx'
import { Spinner } from '../components/ui/Spinner.jsx'

export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  const [rooms, setRooms] = useState([])
  const [state, setState] = useState('loading')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [creating, setCreating] = useState(false)

  const [peopleRoom, setPeopleRoom] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)

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

  const onConfirmDelete = useCallback(async () => {
    const target = deleteTarget
    if (!target) return

    // Drop it from the list first; put it back if the server disagrees.
    setRooms((current) => current.filter((room) => room.roomId !== target.roomId))
    try {
      await api.deleteRoom(target.roomId)
      toast.success('Deleted ' + target.name)
    } catch (error) {
      setRooms((current) => [target, ...current])
      toast.error(error.message)
    }
  }, [deleteTarget, toast])

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
                <RoomCard
                  key={room.roomId}
                  room={room}
                  onOpen={() => navigate('/room/' + room.roomId)}
                  onShowPeople={() => setPeopleRoom(room)}
                  onDelete={() => setDeleteTarget(room)}
                />
              ))}
            </ul>
          )}
        </section>
      </main>

      <RoomPeopleDialog
        room={peopleRoom}
        open={Boolean(peopleRoom)}
        onClose={() => setPeopleRoom(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget ? 'Delete ' + deleteTarget.name + '?' : 'Delete room?'}
        description="The whiteboard, the code, and the whole session history go with it. This cannot be undone."
        confirmLabel="Delete room"
        destructive
        onConfirm={onConfirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  )
}
