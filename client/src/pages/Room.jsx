import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client.js'
import { colorFor } from '../lib/identity.js'
import { useUIStore } from '../store/uiStore.js'
import { useAuth } from '../auth/useAuth.js'
import { useCollabSession } from '../hooks/useCollabSession.js'
import { useCodeRunner } from '../hooks/useCodeRunner.js'
import { CAP, useRoomAccess } from '../hooks/useRoomAccess.js'
import { useAwareness } from '../hooks/useAwareness.js'
import { usePresence } from '../hooks/usePresence.js'
import { useRoomSocket } from '../hooks/useRoomSocket.js'
import { useToast } from '../components/ui/useToast.js'
import { TopBar, Brand } from '../components/TopBar.jsx'
import { SplitPane } from '../components/SplitPane.jsx'
import { PresenceMenu } from '../components/PresenceMenu.jsx'
import { ChatPanel } from '../components/ChatPanel.jsx'
import { FilesPanel } from '../components/FilesPanel.jsx'
import { GeneratePanel } from '../components/Generate/GeneratePanel.jsx'
import { useGeneration } from '../hooks/useGeneration.js'
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
  const { user, identity, token, isAuthenticated, isLoading, logout } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  const [copied, setCopied] = useState(false)
  const [room, setRoom] = useState(null)
  const access = useRoomAccess()
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
  const [generateOpen, setGenerateOpen] = useState(false)
  const copyTimer = useRef(null)

  const { session, status, synced, authError } = useCollabSession(roomId, identity, token)
  const { peers, self } = useAwareness(session?.provider)

  /**
   * What this person tells the room about themselves, and following somebody
   * else. Sharing is remembered per browser. The capabilities come from the
   * server, so somebody who may only look is never announced as editing.
   */
  const sharing = useUIStore((state) => state.sharePresence)
  const setSharing = useUIStore((state) => state.setSharePresence)

  const onFollowEnded = useCallback(
    (reason, name) => {
      const who = name || 'They'
      toast.info(
        reason === 'private'
          ? who + ' stopped sharing their activity, so you are no longer following them'
          : who + ' left the room'
      )
    },
    [toast]
  )

  const presence = usePresence({
    provider: session?.provider,
    canEditCode: access.can(CAP.CODE_EDIT),
    canEditBoard: access.can(CAP.WHITEBOARD_EDIT),
    language,
    sharing,
    onFollowEnded,
  })

  const leader =
    presence.following == null
      ? null
      : (peers.find((peer) => peer.clientId === presence.following) ?? null)

  // The person being followed moved to the other half of the room. That half
  // has to be on screen before it can be scrolled to where they are.
  useEffect(
    () =>
      presence.navigator.on('surface', (surface) => {
        const mode = useUIStore.getState().paneMode
        if ((surface === 'code' && mode === 'board') || (surface === 'board' && mode === 'code')) {
          useUIStore.getState().setPaneMode('split')
        }
      }),
    [presence.navigator]
  )

  // Esc lets go. Bubbling rather than capture, so a dialog that handles its own
  // Escape closes without also ending a follow the person meant to keep.
  const { following: followingId, unfollow } = presence
  useEffect(() => {
    if (followingId == null) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) unfollow()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [followingId, unfollow])
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

  /**
   * The password changed somewhere else, so this token is dead.
   *
   * Without this the tab would sit in the room looking merely disconnected —
   * the socket is gone and the collab provider's reconnect is refused — until
   * something happened to make an API call. Clearing the session turns that
   * into the sign-in page and a sentence explaining why.
   */
  const onSessionEnded = useCallback(
    (payload) => {
      logout()
      toast.error(
        payload?.reason === 'password_reset'
          ? 'Your password was reset, so this session ended. Sign in again.'
          : 'Your password was changed, so this session ended. Sign in again.'
      )
      navigate('/login')
    },
    [logout, toast, navigate]
  )

  /**
   * Only asked for once the panel is opened. Reading the board is a request
   * and checking availability is another, and a room nobody generates in
   * should not pay for either.
   */
  const generationState = useGeneration(roomId, { enabled: generateOpen && isAuthenticated })

  /**
   * Somebody else in the room generated or applied something.
   *
   * The diagram was drawn together, so what it produced belongs to everyone
   * looking at it — and an applied change set has just changed the room's
   * files under everybody. Announced rather than opened: interrupting someone
   * mid-drawing with a dialog they did not ask for would be worse than not
   * telling them.
   */
  const onRemoteGeneration = useCallback(
    (payload) => {
      if (payload?.generation?.requestedByName === user?.name) return
      toast.info(
        (payload?.generation?.requestedByName ?? 'Someone') +
          ' generated code from this whiteboard'
      )
      generationState.noteRemote()
    },
    // The refresh callback, not the whole state: that object is rebuilt every
    // render, and depending on it would rebuild this handler every render too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast, user?.name, generationState.noteRemote]
  )

  const onRemoteApplied = useCallback(
    (payload) => {
      if (!payload?.applied) return
      if (payload?.by?.id === user?.id) return
      toast.info(
        (payload?.by?.name ?? 'Someone') +
          ' added ' +
          payload.applied +
          (payload.applied === 1 ? ' generated file' : ' generated files') +
          ' to this room'
      )
    },
    [toast, user?.id]
  )

  const [chatOpen, setChatOpen] = useState(false)
  const socketRef = useRef(null)
  const chat = useRoomChat({ roomId, socketRef, self: identity, open: chatOpen })

  // Runs are announced to the whole room, so the console shows everyone's.
  const socketHandlers = useMemo(
    () => ({
      'code:run': runner.receive,
      // Queued, running, and how it ended. This is what a Cancel button needs
      // — a run has no id anyone can act on until the room is told.
      'execution:state': runner.receiveState,
      'room:kicked': onKicked,
      'room:chat': chat.receive,
      'session:ended': onSessionEnded,
      'ai:generation': onRemoteGeneration,
      'ai:applied': onRemoteApplied,
    }),
    [
      runner.receive,
      runner.receiveState,
      onKicked,
      chat.receive,
      onSessionEnded,
      onRemoteGeneration,
      onRemoteApplied,
    ]
  )

  // The same socket carries presence, runs and chat, so the panel sends on the
  // connection the room already has rather than opening one of its own.
  /**
   * The join tells us what this person may do here.
   *
   * The REST read does too, but it answers 404 for a room nobody has written
   * a record for yet — which is every room opened by typing its URL. Taking
   * the answer from both means an ad-hoc room is not stuck with everything
   * disabled while it waits for a record that only the join creates.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const onJoined = useCallback((ack) => access.receive(ack?.access), [access.receive])

  const liveSocket = useRoomSocket(roomId, identity, token, socketHandlers, onJoined)
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
      .then((payload) => {
        setRoom(payload.room)
        // What this person may do arrives with the room, so the interface
        // never has to work it out from a role name of its own.
        access.receive(payload.access)
      })
      .catch(() => setRoom(null))
    return () => controller.abort()
    // `access.receive` rather than `access`: the object is rebuilt whenever the
    // capabilities change, and depending on it would refetch the room every
    // time the answer arrived — including the refetch that caused it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, access.receive])

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
    <div
      className="room"
      data-following={leader ? '' : undefined}
      style={leader ? { '--follow-color': leader.user?.color } : undefined}
    >
      {/* Following is a mode, so it is shown as one: a frame in the leader's
          colour around the whole workspace, and a way out that is always in
          the same place. */}
      {leader && (
        <div className="follow-banner" role="status">
          <span>Following {leader.user?.name || 'someone'}</span>
          <button type="button" className="follow-banner__stop" onClick={presence.unfollow}>
            Stop <kbd>Esc</kbd>
          </button>
        </div>
      )}
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
            access={access}
            presence={presence}
            sharing={sharing}
            onSharingChange={setSharing}
          />
          <ChatPanel
            messages={chat.messages}
            unread={chat.unread}
            onSend={chat.send}
            open={chatOpen}
            onOpenChange={setChatOpen}
            canSend={access.can(CAP.CHAT_SEND)}
          />
          {/* Every file route is behind requireAuth, so a guest is told why
              rather than shown a panel that can only fail. */}
          <FilesPanel
            roomId={roomId}
            user={user}
            canUse={isAuthenticated}
            canUpload={access.can(CAP.FILES_UPLOAD)}
            canDelete={access.can(CAP.FILES_DELETE)}
          />
          {/* Turning the board into code. Generating needs an account — it
              spends a real request and is recorded against whoever asked —
              so a guest is told that rather than shown a button that fails. */}
          <button
            type="button"
            className="presence-menu__trigger"
            aria-label="Generate from whiteboard"
            title={
              isAuthenticated
                ? 'Generate code from the whiteboard'
                : 'Sign in to generate code from the whiteboard'
            }
            onClick={() => setGenerateOpen(true)}
            disabled={!isAuthenticated}
          >
            <Icon name="zap" size={16} />
          </button>
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
              readOnly={!access.can(CAP.WHITEBOARD_EDIT)}
              presence={presence}
              sharing={sharing}
            />
          }
          right={
            <CodeEditor
              yText={session.code}
              provider={session.provider}
              peers={peers}
              presence={presence}
              status={status}
              synced={synced}
              runner={runner}
              canEdit={access.can(CAP.CODE_EDIT)}
              canExecute={access.can(CAP.CODE_EXECUTE)}
              accessLoaded={access.loaded}
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
      {replayOpen && (
        <ReplayViewer
          roomId={roomId}
          onClose={() => setReplayOpen(false)}
          summarizeBlocker={
            !isAuthenticated
              ? 'Sign in to use AI summaries of this session'
              : !access.can(CAP.AI_GENERATE)
                ? 'Your role in this room does not include AI features'
                : null
          }
        />
      )}

      <GeneratePanel
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        generation={generationState}
      />
    </div>
  )
}
