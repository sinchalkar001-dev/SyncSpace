import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { loadIdentity, renameIdentity } from '../lib/identity.js'
import { useCollabSession } from '../hooks/useCollabSession.js'
import { useAwareness } from '../hooks/useAwareness.js'
import { useRoomSocket } from '../hooks/useRoomSocket.js'
import { SplitPane } from '../components/SplitPane.jsx'
import { PresenceBar } from '../components/PresenceBar.jsx'
import { ConnectionStatus } from '../components/ConnectionStatus.jsx'
import { Whiteboard } from '../components/Whiteboard/Whiteboard.jsx'
import { CodeEditor } from '../components/Editor/CodeEditor.jsx'

export default function Room() {
  const { roomId } = useParams()
  const [identity, setIdentity] = useState(loadIdentity)
  const [copied, setCopied] = useState(false)

  const { session, status, synced, authError } = useCollabSession(roomId, identity)
  const { peers, self } = useAwareness(session?.provider)
  useRoomSocket(roomId, identity)

  const onRename = useCallback((event) => {
    setIdentity(renameIdentity(event.target.value))
  }, [])

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access can be blocked; the room code stays visible regardless.
    }
  }, [])

  return (
    <div className="room">
      <header className="room__bar">
        <Link to="/" className="room__brand">
          <span className="room__mark">SS</span>
          SyncSpace
        </Link>

        <button type="button" className="room__code" onClick={onCopy} title="Copy room link">
          <span className="room__code-label">Room</span>
          <code>{roomId}</code>
          <span className="room__copy">{copied ? 'Copied' : 'Copy link'}</span>
        </button>

        <div className="room__right">
          <PresenceBar self={self} peers={peers} />
          <input
            className="room__name"
            value={identity.name}
            onChange={onRename}
            maxLength={32}
            aria-label="Your display name"
          />
          <ConnectionStatus status={status} synced={synced} />
        </div>
      </header>

      {authError && <div className="banner banner--error">{authError}</div>}

      {session ? (
        <SplitPane
          left={
            <Whiteboard
              shapes={session.shapes}
              provider={session.provider}
              peers={peers}
              user={identity}
            />
          }
          right={<CodeEditor yText={session.code} provider={session.provider} peers={peers} />}
        />
      ) : (
        <div className="room__loading">Opening room…</div>
      )}
    </div>
  )
}
