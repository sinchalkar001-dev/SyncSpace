import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAuth } from '../auth/useAuth.js'
import { useToast } from '../components/ui/useToast.js'
import {
  activityByDay,
  continueRoom,
  isMine,
  kindFilters,
  partitionRooms,
  roomLabel,
  selectRooms,
  summarise,
} from '../lib/rooms.js'
import { TopBar, Brand, TopNav } from '../components/TopBar.jsx'
import { UserMenu } from '../components/UserMenu.jsx'
import { RoomCard } from '../components/RoomCard.jsx'
import { ContinueSession } from '../components/ContinueSession.jsx'
import { ActivityFeed } from '../components/ActivityFeed.jsx'
import { RoomFilters } from '../components/RoomFilters.jsx'
import { VerifyEmailNotice } from '../components/VerifyEmailNotice.jsx'
import { RoomPeopleDialog } from '../components/RoomPeopleDialog.jsx'
import { RoomDetailsDialog } from '../components/RoomDetailsDialog.jsx'
import { NewRoomDialog } from '../components/NewRoomDialog.jsx'
import { ConfirmDialog } from '../components/ui/Modal.jsx'
import { Button } from '../components/ui/Button.jsx'
import { Icon } from '../components/ui/Icon.jsx'
import { Sparkline } from '../components/ui/Sparkline.jsx'
import { EmptyState } from '../components/ui/EmptyState.jsx'
import { RoomListSkeleton } from '../components/ui/Skeleton.jsx'

const NAV = [{ to: '/dashboard', label: 'Rooms', icon: 'grid' }]

/**
 * The workspace this account has, and the way back into it.
 *
 * Built around one belief about who is looking at it: somebody who has a room
 * in mind. Almost never "show me my rooms" and almost always "get me back into
 * the one I was in", or "the interview one", or "the one Ayush was in this
 * morning" — so the page leads with the room you were last in, then the ones
 * you pinned, then everything else behind a search that also matches
 * descriptions and the people in them.
 *
 * Two requests on mount and none after. Rooms arrive with their collaborators
 * and this account's pins already folded in, so every search, filter and sort
 * below is a pure function of memory: typing costs a re-render, never a
 * round trip, which is what keeps forty rooms as quick as four.
 */
export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  const [rooms, setRooms] = useState([])
  const [state, setState] = useState('loading')

  const [events, setEvents] = useState([])
  const [feedState, setFeedState] = useState('loading')

  const [code, setCode] = useState('')

  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [sort, setSort] = useState('recent')
  const [archived, setArchived] = useState(false)

  const [creating, setCreating] = useState(false)
  const [peopleRoom, setPeopleRoom] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [detailsTarget, setDetailsTarget] = useState(null)

  const searchRef = useRef(null)

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

  /**
   * The feed loads beside the rooms and fails on its own.
   *
   * Separate state rather than one combined `state`, because these two are not
   * equally important: rooms failing is the page failing, and the feed failing
   * is a panel that says so while everything else keeps working.
   */
  const loadFeed = useCallback((signal) => {
    setFeedState('loading')
    return api
      .activity(20, signal)
      .then((payload) => {
        setEvents(payload.activity)
        setFeedState('ready')
      })
      .catch((error) => {
        if (error?.name === 'AbortError') return
        setFeedState('error')
      })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    loadFeed(controller.signal)
    return () => controller.abort()
  }, [load, loadFeed])

  /**
   * "/" jumps to the search box, the way it does in every tool this sits
   * beside. Ignored while somebody is already typing into something, so it
   * cannot swallow a slash meant for a room name.
   */
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const active = document.activeElement
      const tag = active?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active?.isContentEditable) {
        return
      }
      event.preventDefault()
      searchRef.current?.focus()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const stats = useMemo(() => summarise(rooms, user?.id), [rooms, user?.id])
  const days = useMemo(() => activityByDay(rooms), [rooms])
  // Counted over the rooms currently in scope, so the numbers beside the types
  // describe the list being filtered rather than a different one.
  const kinds = useMemo(
    () => kindFilters(rooms.filter((room) => Boolean(room.archived) === archived)),
    [rooms, archived]
  )

  const visible = useMemo(
    () => selectRooms(rooms, { query, kind, sort, archived, userId: user?.id }),
    [rooms, query, kind, sort, archived, user?.id]
  )

  const { pinned, rest } = useMemo(() => partitionRooms(visible), [visible])
  const resume = useMemo(() => continueRoom(rooms), [rooms])

  const patchRoom = useCallback((roomId, changes) => {
    setRooms((current) =>
      current.map((room) => (room.roomId === roomId ? { ...room, ...changes } : room))
    )
  }, [])

  const onCreate = useCallback(
    async (body) => {
      try {
        const { room } = await api.createRoom(body)
        toast.success('Room created')
        navigate('/room/' + room.roomId)
      } catch (error) {
        toast.error(error.message)
        throw error
      }
    },
    [navigate, toast]
  )

  const onJoin = (event) => {
    event.preventDefault()
    const trimmed = code.trim()
    if (trimmed) navigate('/room/' + encodeURIComponent(trimmed))
  }

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

  /**
   * Pin and archive are optimistic and share one path.
   *
   * Both are instant, private, and reversible by doing the same thing again,
   * so waiting on the server before moving the card would make a free action
   * feel expensive. The previous value is captured first and put back if the
   * write is refused.
   */
  const onPreference = useCallback(
    async (room, preference) => {
      const before = { pinned: room.pinned, archived: room.archived }
      patchRoom(room.roomId, preference)

      try {
        await api.setRoomPreference(room.roomId, preference)

        if (preference.archived !== undefined) {
          toast.success(
            preference.archived
              ? roomLabel(room) + ' archived'
              : roomLabel(room) + ' is back in your rooms'
          )
        }
      } catch (error) {
        patchRoom(room.roomId, before)
        toast.error(error.message)
      }
    },
    [patchRoom, toast]
  )

  const onDetailsSubmit = useCallback(
    async (patch) => {
      const target = detailsTarget
      if (!target) return

      try {
        const { room } = await api.updateRoom(target.roomId, patch)
        patchRoom(target.roomId, room)
        toast.success('Saved')
      } catch (error) {
        toast.error(error.message)
        throw error
      }
    },
    [detailsTarget, patchRoom, toast]
  )

  const onConfirmDelete = useCallback(async () => {
    const target = deleteTarget
    if (!target) return

    // Drop it from the list first; put it back if the server disagrees.
    setRooms((current) => current.filter((room) => room.roomId !== target.roomId))
    try {
      await api.deleteRoom(target.roomId)
      toast.success('Deleted ' + roomLabel(target))
    } catch (error) {
      setRooms((current) => [target, ...current])
      toast.error(error.message)
    }
  }, [deleteTarget, toast])

  const openRoom = useCallback((roomId) => navigate('/room/' + roomId), [navigate])

  /**
   * One stable handler each, rather than a closure per card.
   *
   * `RoomCard` is memoised so that typing in the search box re-renders only the
   * cards whose data actually changed. Building `() => open(room)` per card
   * would hand every card a brand new function on every keystroke and defeat
   * that entirely, which is precisely the case a long list cannot afford.
   */
  const onOpenRoom = useCallback((room) => openRoom(room.roomId), [openRoom])
  const onShowPeople = useCallback((room) => setPeopleRoom(room), [])
  const onRename = useCallback((room) => setDetailsTarget(room), [])
  const onDelete = useCallback((room) => setDeleteTarget(room), [])
  const onTogglePin = useCallback(
    (room) => onPreference(room, { pinned: !room.pinned }),
    [onPreference]
  )
  const onToggleArchive = useCallback(
    (room) => onPreference(room, { archived: !room.archived }),
    [onPreference]
  )

  const filtering = query.trim() !== '' || kind !== 'all'
  const nothingAtAll = state === 'ready' && rooms.length === 0

  const cardProps = (room, index) => ({
    key: room.roomId,
    room,
    index,
    mine: isMine(room, user?.id),
    onOpen: onOpenRoom,
    onShowPeople,
    onRename,
    onToggleVisibility,
    onTogglePin,
    onToggleArchive,
    onDelete,
  })

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
        <header className="dash__head">
          <div className="dash__intro">
            <h1 className="dash__greeting">Hello, {user?.name}</h1>

            {/* One line instead of a grid of stat tiles. The figures matter,
                but they are context for the rooms below, not the subject of
                the page — and four boxes of numbers is the exact house style
                of the software this is not. */}
            {state === 'ready' && rooms.length > 0 ? (
              <p className="dash__sub nums">
                {stats.total} room{stats.total === 1 ? '' : 's'}
                {stats.live > 0 && <span className="dash__live"> · {stats.live} active now</span>}
                {stats.shared > 0 && <span> · {stats.shared} shared with you</span>}
                {stats.pinned > 0 && <span> · {stats.pinned} pinned</span>}
              </p>
            ) : (
              <p className="dash__sub">Start a session, or pick up where you left off.</p>
            )}
          </div>

          <div className="dash__actions">
            <form className="dash__join" onSubmit={onJoin}>
              <input
                className="input"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Room code"
                aria-label="Join with a room code"
              />
              <Button type="submit" disabled={!code.trim()}>
                Join
              </Button>
            </form>

            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New room
            </Button>
          </div>
        </header>

        {/* Shows only while the address is unverified, and carries the only
            control that can ask for another link. */}
        <VerifyEmailNotice />

        {state === 'ready' && (
          <ContinueSession
            room={resume}
            mine={isMine(resume, user?.id)}
            onOpen={() => openRoom(resume.roomId)}
            onShowPeople={() => setPeopleRoom(resume)}
          />
        )}

        <div className="dash__grid">
          <div className="dash__main">
            <section className="section" aria-labelledby="your-rooms">
              <div className="section__head">
                <h2 className="section__title" id="your-rooms">
                  {archived ? 'Archived rooms' : 'Your rooms'}
                </h2>
                {state === 'ready' && rooms.length > 0 && (
                  <span className="muted nums">
                    {filtering ? visible.length + ' of ' + rooms.length : visible.length + ' shown'}
                  </span>
                )}
              </div>

              {state === 'ready' && rooms.length > 0 && (
                <RoomFilters
                  ref={searchRef}
                  query={query}
                  onQuery={setQuery}
                  kind={kind}
                  onKind={setKind}
                  kinds={kinds}
                  sort={sort}
                  onSort={setSort}
                  archived={archived}
                  onArchived={setArchived}
                  archivedCount={stats.archived}
                />
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

              {nothingAtAll && (
                <EmptyState
                  icon="grid"
                  title="No rooms yet"
                  body="Create your first room, then share its code. Anyone you invite lands on the same canvas and the same code buffer."
                  action={
                    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                      Create your first room
                    </Button>
                  }
                />
              )}

              {state === 'ready' && rooms.length > 0 && visible.length === 0 && (
                <EmptyState
                  icon={archived ? 'archive' : 'search'}
                  title={archived ? 'Nothing archived' : 'No rooms match'}
                  body={
                    archived
                      ? 'Rooms you archive are kept here, out of the way but not deleted.'
                      : 'Nothing here fits that search and filter.'
                  }
                  action={
                    <Button
                      onClick={() => {
                        setQuery('')
                        setKind('all')
                        setArchived(false)
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              )}

              {/* Pinned rooms are lifted out rather than sorted to the top, so
                  the order you put them in survives changing the sort below. */}
              {state === 'ready' && pinned.length > 0 && (
                <>
                  <h3 className="section__sub" id="pinned-rooms">
                    <Icon name="pin" size={13} />
                    Pinned
                  </h3>
                  <ul className="roomlist" aria-labelledby="pinned-rooms">
                    {pinned.map((room, index) => (
                      <RoomCard {...cardProps(room, index)} />
                    ))}
                  </ul>
                </>
              )}

              {state === 'ready' && rest.length > 0 && (
                <>
                  {pinned.length > 0 && (
                    <h3 className="section__sub" id="other-rooms">
                      Everything else
                    </h3>
                  )}
                  <ul
                    className="roomlist"
                    aria-labelledby={pinned.length > 0 ? 'other-rooms' : 'your-rooms'}
                  >
                    {rest.map((room, index) => (
                      <RoomCard {...cardProps(room, index)} />
                    ))}
                  </ul>
                </>
              )}
            </section>
          </div>

          <aside className="dash__aside">
            <ActivityFeed
              state={feedState}
              events={events}
              rooms={rooms}
              onOpenRoom={openRoom}
            />

            {state === 'ready' && rooms.length > 0 && (
              <section className="dash__activity" aria-label="Rooms touched in the last 7 days">
                <div className="dash__activity-head">
                  <span className="dash__activity-title">Last 7 days</span>
                  <span className="muted nums">{stats.total} rooms</span>
                </div>
                <Sparkline days={days} />
              </section>
            )}
          </aside>
        </div>
      </main>

      <NewRoomDialog open={creating} onClose={() => setCreating(false)} onSubmit={onCreate} />

      <RoomDetailsDialog
        room={detailsTarget}
        open={Boolean(detailsTarget)}
        onClose={() => setDetailsTarget(null)}
        onSubmit={onDetailsSubmit}
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
