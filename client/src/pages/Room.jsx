import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client.js'
import { colorFor } from '../lib/identity.js'
import { useUIStore } from '../store/uiStore.js'
import { useAuth } from '../auth/useAuth.js'
import { useCollabSession } from '../hooks/useCollabSession.js'
import { useCodeRunner } from '../hooks/useCodeRunner.js'
import { useAwareness } from '../hooks/useAwareness.js'
import { useRoomSocket } from '../hooks/useRoomSocket.js'
import { useToast } from '../components/ui/useToast.js'
import { TopBar, Brand } from '../components/TopBar.jsx'
import { SplitPane } from '../components/SplitPane.jsx'
import { PresenceMenu } from '../components/PresenceMenu.jsx'
import { ChatPanel } from '../components/ChatPanel.jsx'
import { FilesPanel } from '../components/FilesPanel.jsx'
import { useRoomChat } from '../hooks/useRoomChat.js'
import { ConnectionStatus } from '../components/ConnectionStatus.jsx'
import { Segmented } from '../components/ui/Segmented.jsx'
import { UserMenu } from '../components/UserMenu.jsx'
import { Icon } from '../components/ui/Icon.jsx'
import { LoadingBlock } from '../components/ui/Spinner.jsx'
import { Whiteboard } from '../components/Whiteboard/Whiteboard.jsx'
import { CodeEditor } from '../components/Editor/CodeEditor.jsx'
import { CommandPalette } from '../components/CommandPalette.jsx'
import { ReplayViewer } from '../components/Replay/ReplayViewer.jsx'
import { ShortcutsPanel } from '../components/ShortcutsPanel.jsx'
import { LANGUAGES } from '../lib/languages.js'
import { TOOLS } from '../store/uiStore.js'

const VIEWS = [
  { value: 'board', label: 'Board', icon: 'pen' },
  { value: 'split', label: 'Split', icon: 'grid' },
  { value: 'code', label: 'Code', icon: 'code' },
]

const TOOL_LABELS = {
  select: 'Select',
  hand: 'Hand (pan)',
  pen: 'Pen',
  segment: 'Line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  diamond: 'Diamond',
  ellipse: 'Ellipse',
  text: 'Text',
  eraser: 'Eraser',
}

const TOOL_KEYS = { select: 'V', hand: 'H', pen: 'P', segment: 'L', arrow: 'A', rect: 'R', diamond: 'D', ellipse: 'O', text: 'T', eraser: 'E' }

const FONT_STEP = 0.5
const FONT_MIN = 10
const FONT_MAX = 22

/** True when a keystroke belongs to whatever the user is typing into. */
function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export default function Room() {
  const { roomId } = useParams()
  const { user, identity, token, isAuthenticated, isLoading } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  const [copied, setCopied] = useState(false)
  const [room, setRoom] = useState(null)
  const paneMode = useUIStore((state) => state.paneMode)
  const setPaneMode = useUIStore((state) => state.setPaneMode)
  const setTool = useUIStore((state) => state.setTool)
  const setLanguage = useUIStore((state) => state.setLanguage)
  const language = useUIStore((state) => state.language)
  const editorPrefs = useUIStore((state) => state.editor)
  const toggleEditorOption = useUIStore((state) => state.toggleEditorOption)
  const setEditorOption = useUIStore((state) => state.setEditorOption)

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [replayOpen, setReplayOpen] = useState(false)
  const copyTimer = useRef(null)

  const { session, status, synced, authError } = useCollabSession(roomId, identity, token)
  const { peers, self } = useAwareness(session?.provider)
  const runner = useCodeRunner(roomId, identity?.name)

  /**
   * Losing access while sitting in the room. The collab connection reports it
   * too — it reconnects, fails authentication, and the gate below takes over —
   * but that says nothing about why, and a whiteboard that quietly stops
   * syncing is the worst way to find out you were removed.
   */
  const onKicked = useCallback(
    (payload) => {
      toast.error(
        payload?.reason === 'room_deleted'
          ? 'This room was deleted by its owner'
          : payload?.reason === 'removed_by_owner'
            ? 'You were removed from this room by its owner'
            : 'This room is private now, and you are not on its guest list'
      )
      navigate(isAuthenticated ? '/dashboard' : '/')
    },
    [toast, navigate, isAuthenticated]
  )

  const [chatOpen, setChatOpen] = useState(false)
  const socketRef = useRef(null)
  const chat = useRoomChat({ roomId, socketRef, self: identity, open: chatOpen })

  // Runs are announced to the whole room, so the console shows everyone's.
  const socketHandlers = useMemo(
    () => ({ 'code:run': runner.receive, 'room:kicked': onKicked, 'room:chat': chat.receive }),
    [runner.receive, onKicked, chat.receive]
  )

  // The same socket carries presence, runs and chat, so the panel sends on the
  // connection the room already has rather than opening one of its own.
  const liveSocket = useRoomSocket(roomId, identity, token, socketHandlers)
  socketRef.current = liveSocket.current

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

  // Ctrl/Cmd+K is claimed on the capture phase so Monaco, which treats it as a
  // chord prefix, never swallows it first.
  useEffect(() => {
    const onKeyDown = (event) => {
      const modifier = event.metaKey || event.ctrlKey

      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        event.stopPropagation()
        setPaletteOpen((open) => !open)
        return
      }

      if (event.key === '?' && !isTyping(event.target)) {
        event.preventDefault()
        setShortcutsOpen((open) => !open)
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const commands = useMemo(() => {
    const list = []

    for (const view of VIEWS) {
      list.push({
        id: 'view:' + view.value,
        group: 'View',
        icon: view.icon,
        title: view.label === 'Split' ? 'Split view' : view.label + ' only',
        detail: paneMode === view.value ? 'current' : undefined,
        run: () => setPaneMode(view.value),
      })
    }

    for (const tool of TOOLS) {
      list.push({
        id: 'tool:' + tool,
        group: 'Board',
        icon: tool === 'hand' ? 'hand' : tool,
        title: TOOL_LABELS[tool] || tool,
        keywords: 'tool draw',
        hint: TOOL_KEYS[tool],
        run: () => {
          // Picking a board tool while the board is hidden is a request to see it.
          if (paneMode === 'code') setPaneMode('split')
          setTool(tool)
        },
      })
    }

    list.push(
      {
        id: 'run:code',
        group: 'Editor',
        icon: 'play',
        title: 'Run the code',
        keywords: 'execute output console',
        hint: 'Ctrl ⏎',
        detail: runner.blocker(language) ? 'unavailable' : undefined,
        // Only the editor knows the current buffer, so this asks it to run
        // rather than trying to run anything itself.
        run: runner.request,
      },
      {
        id: 'editor:wordWrap',
        group: 'Editor',
        icon: 'text',
        title: (editorPrefs.wordWrap ? 'Disable' : 'Enable') + ' word wrap',
        run: () => toggleEditorOption('wordWrap'),
      },
      {
        id: 'editor:minimap',
        group: 'Editor',
        icon: 'layers',
        title: (editorPrefs.minimap ? 'Hide' : 'Show') + ' minimap',
        run: () => toggleEditorOption('minimap'),
      },
      {
        id: 'editor:fontUp',
        group: 'Editor',
        icon: 'plus',
        title: 'Increase font size',
        run: () =>
          setEditorOption('fontSize', Math.min(FONT_MAX, editorPrefs.fontSize + FONT_STEP)),
      },
      {
        id: 'editor:fontDown',
        group: 'Editor',
        icon: 'minus',
        title: 'Decrease font size',
        run: () =>
          setEditorOption('fontSize', Math.max(FONT_MIN, editorPrefs.fontSize - FONT_STEP)),
      }
    )

    for (const name of LANGUAGES) {
      list.push({
        id: 'lang:' + name,
        group: 'Language',
        icon: 'code',
        title: 'Switch to ' + name,
        keywords: 'language syntax ' + name,
        detail: name === language ? 'current' : undefined,
        run: () => setLanguage(name),
      })
    }

    list.push(
      {
        id: 'room:copy',
        group: 'Room',
        icon: 'copy',
        title: 'Copy room link',
        run: onCopy,
      },
      {
        id: 'room:replay',
        group: 'Room',
        icon: 'clock',
        title: 'Replay this room’s history',
        keywords: 'history timeline scrub playback past',
        run: () => setReplayOpen(true),
      },
      {
        id: 'room:shortcuts',
        group: 'Room',
        icon: 'key',
        title: 'Keyboard shortcuts',
        hint: '?',
        run: () => setShortcutsOpen(true),
      },
      {
        id: 'room:leave',
        group: 'Room',
        icon: 'arrowRight',
        title: 'Leave this room',
        run: () => navigate(isAuthenticated ? '/dashboard' : '/'),
      }
    )

    return list
  }, [
    runner,
    paneMode,
    setPaneMode,
    setTool,
    editorPrefs,
    toggleEditorOption,
    setEditorOption,
    language,
    setLanguage,
    onCopy,
    navigate,
    isAuthenticated,
  ])

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
            {isAuthenticated ? (
              /* A refused provider will not try again on its own, and the usual
                 reason to be standing here is an invite that has just arrived. */
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
            ) : (
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
          <PresenceMenu
            room={room}
            roomId={roomId}
            self={self}
            peers={peers}
            user={user}
            onRoomChange={setRoom}
          />
          <ChatPanel
            messages={chat.messages}
            unread={chat.unread}
            onSend={chat.send}
            open={chatOpen}
            onOpenChange={setChatOpen}
          />
          {/* Every file route is behind requireAuth, so a guest is told why
              rather than shown a panel that can only fail. */}
          <FilesPanel roomId={roomId} user={user} canUse={isAuthenticated} />
          {/* Replay reads the update log, which is optionalAuth like the room
              itself — whoever can open the room can watch how it was built. */}
          <button
            type="button"
            className="presence-menu__trigger"
            aria-label="Room history"
            title="Replay this room’s history"
            onClick={() => setReplayOpen(true)}
          >
            <Icon name="clock" size={16} />
          </button>
          <div className="room__views">
            <Segmented
              options={VIEWS}
              value={paneMode}
              onChange={setPaneMode}
              label="Workspace view"
            />
          </div>
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
          right={
            <CodeEditor
              yText={session.code}
              provider={session.provider}
              peers={peers}
              status={status}
              synced={synced}
              runner={runner}
            />
          }
        />
      ) : (
        <LoadingBlock label="Opening room" />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
      <ShortcutsPanel open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* Mounted only while open: closing should forget the position, the
          cached frames and the playback state, and unmounting says so more
          plainly than resetting six pieces of state would. */}
      {replayOpen && <ReplayViewer roomId={roomId} onClose={() => setReplayOpen(false)} />}
    </div>
  )
}
