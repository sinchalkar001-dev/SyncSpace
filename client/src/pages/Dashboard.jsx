import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAuth } from '../auth/useAuth.js'
import { useToast } from '../components/ui/useToast.js'
import { activityByDay, FILTERS, roomLabel, selectRooms, SORTS, summarise } from '../lib/rooms.js'
import { TopBar, Brand, TopNav } from '../components/TopBar.jsx'
import { UserMenu } from '../components/UserMenu.jsx'
import { RoomCard } from '../components/RoomCard.jsx'
import { VerifyEmailNotice } from '../components/VerifyEmailNotice.jsx'
import { RoomPeopleDialog } from '../components/RoomPeopleDialog.jsx'
import { RenameRoomDialog } from '../components/RenameRoomDialog.jsx'
import { ConfirmDialog } from '../components/ui/Modal.jsx'
import { Button } from '../components/ui/Button.jsx'
import { Icon } from '../components/ui/Icon.jsx'
import { Segmented } from '../components/ui/Segmented.jsx'
import { StatCard } from '../components/ui/StatCard.jsx'
import { Sparkline } from '../components/ui/Sparkline.jsx'
import { EmptyState } from '../components/ui/EmptyState.jsx'
import { RoomListSkeleton, StatGridSkeleton } from '../components/ui/Skeleton.jsx'

const NAV = [{ to: '/dashboard', label: 'Rooms', icon: 'grid' }]

export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  const [rooms, setRooms] = useState([])
  const [state, setState] = useState('loading')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [creating, setCreating] = useState(false)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('recent')

  const [peopleRoom, setPeopleRoom] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [renameTarget, setRenameTarget] = useState(null)

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

  // Everything below is derived from the rooms already fetched — no extra
  // requests, and no backend stats endpoint to keep in sync.
  const stats = useMemo(() => summarise(rooms), [rooms])
  const days = useMemo(() => activityByDay(rooms), [rooms])
  const visible = useMemo(
    () => selectRooms(rooms, { query, filter, sort }),
    [rooms, query, filter, sort]
  )

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

  const patchRoom = useCallback((roomId, changes) => {
    setRooms((current) =>
      current.map((room) => (room.roomId === roomId ? { ...room, ...changes } : room))
    )
  }, [])

  const onToggleVisibility = useCallback(
    async (room) => {
      const isPublic = !room.isPublic
      patchRoom(room.roomId, { isPublic })
      try {
        await api.updateRoom(room.roomId, { isPublic })
        toast.success(isPublic ? 'Anyone with the link can now join' : 'Room is private again')
      } catch (error) {
        patchRoom(room.roomId, { isPublic: room.isPublic })
        toast.error(error.message)
      }
    },
    [patchRoom, toast]
  )

  const onRenameSubmit = useCallback(
    async (next) => {
      const target = renameTarget
      if (!target) return
      try {
        const { room } = await api.updateRoom(target.roomId, { name: next })
        patchRoom(target.roomId, room)
        toast.success('Renamed to ' + room.name)
      } catch (error) {
        toast.error(error.message)
        throw error
      }
    },
    [renameTarget, patchRoom, toast]
  )

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

  const filtering = query.trim() !== '' || filter !== 'all'

  return (
    <div className="shell">
      <TopBar>
        <Brand to="/dashboard" />
        <TopNav items={NAV} />
        <div className="topbar__right">
          <UserMenu />
        </div>
      </TopBar>

      <main className="page anim-page" id="main">
        <div className="dash__hero">
          <div>
            <h1 className="dash__greeting">Hello, {user?.name}</h1>
            <p className="dash__sub">Start a session, or pick up where you left off.</p>
          </div>
        </div>

        {/* Shows only while the address is unverified, and carries the only
            control that can ask for another link. */}
        <VerifyEmailNotice />

        {/* Overview: figures on the left, a week of activity on the right. */}
        <section className="dash__overview" aria-label="Overview">
          {state === 'loading' ? (
            <StatGridSkeleton />
          ) : (
            <div className="statgrid">
              <StatCard icon="grid" label="Rooms" value={stats.total} />
              <StatCard icon="activity" label="Active now" value={stats.live} tone="ok" />
              <StatCard icon="users" label="Members" value={stats.collaborators} tone="info" />
              <StatCard
                icon="globe"
                label="Shared publicly"
                value={stats.publicCount}
                suffix={'of ' + stats.total}
                tone="warn"
              />
            </div>
          )}

          <div className="dash__activity">
            <div className="dash__activity-head">
              <span className="dash__activity-title">Last 7 days</span>
              <span className="muted nums">{stats.total} rooms</span>
            </div>
            <Sparkline days={days} />
          </div>
        </section>

        {/* Create and join, side by side — both are one field and one click. */}
        <section className="dash__overview" aria-label="Start a session">
          <form className="card" onSubmit={onCreate}>
            <p className="card__title">Start a room</p>
            <p className="card__hint">Private by default. Invite people from inside the room.</p>
            <div className="hero__row" style={{ marginTop: 'var(--space-4)' }}>
              <div className="field" style={{ marginBottom: 0, flex: 1 }}>
                <div className="field__wrap">
                  <input
                    className="input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Room name (optional)"
                    aria-label="New room name"
                    maxLength={80}
                  />
                </div>
              </div>
              <Button type="submit" variant="primary" loading={creating} icon="plus">
                Create
              </Button>
            </div>
          </form>

          <form className="card" onSubmit={onJoin}>
            <p className="card__title">Join with a code</p>
            <p className="card__hint">Paste the code a teammate shared with you.</p>
            <div className="hero__row" style={{ marginTop: 'var(--space-4)' }}>
              <div className="field" style={{ marginBottom: 0, flex: 1 }}>
                <div className="field__wrap">
                  <input
                    className="input"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="Room code"
                    aria-label="Room code"
                  />
                </div>
              </div>
              <Button type="submit" disabled={!code.trim()}>
                Join
              </Button>
            </div>
          </form>
        </section>

        <section className="section" aria-labelledby="your-rooms">
          <div className="section__head">
            <h2 className="section__title" id="your-rooms">
              Your rooms
            </h2>
            {state === 'ready' && rooms.length > 0 && (
              <span className="muted nums">
                {filtering ? visible.length + ' of ' + rooms.length : rooms.length + ' total'}
              </span>
            )}
          </div>

          {state === 'ready' && rooms.length > 0 && (
            <div className="roomtools">
              <div className="roomtools__search">
                <Icon name="search" size={15} />
                <input
                  className="input"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by name or code"
                  aria-label="Search rooms"
                />
              </div>

              <Segmented options={FILTERS} value={filter} onChange={setFilter} label="Filter rooms" />

              <label className="roomtools__sort">
                <span className="sr-only">Sort rooms</span>
                <select value={sort} onChange={(event) => setSort(event.target.value)}>
                  {SORTS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {state === 'loading' && (
            <>
              <span className="sr-only" role="status">
                Loading your rooms
              </span>
              <RoomListSkeleton />
            </>
          )}

          {state === 'error' && (
            <EmptyState
              variant="error"
              title="Could not load your rooms"
              body="The request did not reach the server, or it refused. Your rooms are safe — this is only the list."
              action={
                <Button onClick={() => load()} icon="redo">
                  Retry
                </Button>
              }
            />
          )}

          {state === 'ready' && rooms.length === 0 && (
            <EmptyState
              icon="grid"
              title="No rooms yet"
              body="Create your first room above, then share its link. Anyone you invite lands on the same canvas and the same code buffer."
            />
          )}

          {state === 'ready' && rooms.length > 0 && visible.length === 0 && (
            <EmptyState
              icon="search"
              title="No rooms match"
              body="Nothing here fits that search and filter."
              action={
                <Button
                  onClick={() => {
                    setQuery('')
                    setFilter('all')
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          )}

          {state === 'ready' && visible.length > 0 && (
            <ul className="roomlist">
              {visible.map((room, index) => (
                <RoomCard
                  key={room.roomId}
                  room={room}
                  index={index}
                  onOpen={() => navigate('/room/' + room.roomId)}
                  onShowPeople={() => setPeopleRoom(room)}
                  onRename={() => setRenameTarget(room)}
                  onToggleVisibility={() => onToggleVisibility(room)}
                  onDelete={() => setDeleteTarget(room)}
                />
              ))}
            </ul>
          )}
        </section>
      </main>

      <RenameRoomDialog
        room={renameTarget}
        open={Boolean(renameTarget)}
        onClose={() => setRenameTarget(null)}
        onSubmit={onRenameSubmit}
      />

      <RoomPeopleDialog
        room={peopleRoom}
        open={Boolean(peopleRoom)}
        onClose={() => setPeopleRoom(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget ? 'Delete ' + roomLabel(deleteTarget) + '?' : 'Delete room?'}
        description="The whiteboard, the code, and the whole session history go with it. This cannot be undone."
        confirmLabel="Delete room"
        destructive
        onConfirm={onConfirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  )
}
