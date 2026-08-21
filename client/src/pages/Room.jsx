import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client.js'
import { colorFor } from '../lib/identity.js'
import { useAuth } from '../auth/useAuth.js'
import { useCollabSession } from '../hooks/useCollabSession.js'
import { useAwareness } from '../hooks/useAwareness.js'
import { useRoomSocket } from '../hooks/useRoomSocket.js'
import { useToast } from '../components/ui/useToast.js'
import { TopBar, Brand } from '../components/TopBar.jsx'
import { SplitPane } from '../components/SplitPane.jsx'
import { PresenceBar } from '../components/PresenceBar.jsx'
import { ConnectionStatus } from '../components/ConnectionStatus.jsx'
import { UserMenu } from '../components/UserMenu.jsx'
import { Icon } from '../components/ui/Icon.jsx'
import { LoadingBlock } from '../components/ui/Spinner.jsx'
import { Whiteboard } from '../components/Whiteboard/Whiteboard.jsx'
import { CodeEditor } from '../components/Editor/CodeEditor.jsx'

export default function Room() {
  const { roomId } = useParams()
  const { identity, token, isAuthenticated, isLoading } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  const [copied, setCopied] = useState(false)
  const [room, setRoom] = useState(null)
  const copyTimer = useRef(null)

  const { session, status, synced, authError } = useCollabSession(roomId, identity, token)
  const { peers, self } = useAwareness(session?.provider)
  useRoomSocket(roomId, identity)

  // A dropped connection is worth telling the user about; a restored one too.
  const previousStatus = useRef(status)
  useEffect(() => {
    if (previousStatus.current === 'connected' && status === 'disconnected') {
      toast.error('Connection lost — reconnecting. Your edits are queued locally.')
    }
    if (previousStatus.current === 'disconnected' && status === 'connected') {
      toast.success('Back online')
    }
    previousStatus.current = status
  }, [status, toast])

  useEffect(() => () => clearTimeout(copyTimer.current), [])

  // Room metadata is a nicety, not a gate: the canvas opens either way.
  useEffect(() => {
    if (!roomId) return undefined
    const controller = new AbortController()
    api
      .getRoom(roomId, controller.signal)
      .then((payload) => setRoom(payload.room))
      .catch(() => setRoom(null))
    return () => controller.abort()
  }, [roomId])

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      copyTimer.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.info('Copy failed — the room code is in the address bar')
    }
  }, [toast])

  if (isLoading) return <LoadingBlock label="Restoring your session" />

  if (authError) {
    return (
      <main className="gate" id="main" role="alert">
        <div className="gate__card">
          <span className="empty__icon" style={{ margin: '0 auto var(--space-4)' }}>
            <Icon name="lock" size={22} />
          </span>

          <h1>You cannot open this room</h1>
          <p>{authError}</p>
          <p className="muted">
            Private rooms are limited to their owner and invited members. Ask for an invite, or sign
            in with the account that was invited.
          </p>

          <div className="gate__actions">
            {!isAuthenticated && (
              <Link className="btn btn--primary" to="/login" state={{ from: '/room/' + roomId }}>
                Sign in
              </Link>
            )}
            <Link className="btn" to={isAuthenticated ? '/dashboard' : '/'}>
              Back
            </Link>
          </div>
        </div>
      </main>
    )
  }

  return (
    <div className="room">
      <TopBar flush>
        <Brand
          onClick={() => navigate(isAuthenticated ? '/dashboard' : '/')}
          showWord={false}
          title="Leave room"
        />

        <div className="room__identity">
          <span className="room__dot" style={{ background: colorFor(roomId) }} aria-hidden="true" />
          <span className="room__name">{room?.name || 'Untitled room'}</span>
          {room && !room.isPublic && (
            <span className="pill">
              <Icon name="lock" size={11} />
              Private
            </span>
          )}

          <button type="button" className="room__code" onClick={onCopy} title="Copy room link">
            <code>{roomId}</code>
            <span className={'room__copy' + (copied ? ' is-shown' : '')}>
              <Icon name={copied ? 'check' : 'copy'} size={12} />
              <span className="room__copy-label">{copied ? 'Copied' : 'Copy link'}</span>
            </span>
          </button>
        </div>

        <div className="topbar__right">
          <PresenceBar self={self} peers={peers} />
          <ConnectionStatus status={status} synced={synced} />
          <UserMenu compact />
        </div>
      </TopBar>

      {session ? (
        <SplitPane
          id="main"
          left={
            <Whiteboard
              shapes={session.shapes}
              provider={session.provider}
              undoManager={session.undoManager}
              peers={peers}
              user={identity}
            />
          }
          right={<CodeEditor yText={session.code} provider={session.provider} peers={peers} />}
        />
      ) : (
        <LoadingBlock label="Opening room" />
      )}
    </div>
  )
}
