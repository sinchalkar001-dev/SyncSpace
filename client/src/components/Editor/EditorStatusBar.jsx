import { Icon } from '../ui/Icon.jsx'

const SYNC_COPY = {
  connecting: { label: 'Connecting', icon: 'clock', tone: 'warn' },
  connected: { label: 'Synced', icon: 'check', tone: 'ok' },
  disconnected: { label: 'Offline', icon: 'alert', tone: 'danger' },
}

/**
 * The line along the bottom of the code pane.
 *
 * Deliberately sparse: position, language, indentation, sync and who else is
 * here. Anything more and it stops being scannable at a glance.
 */
export function EditorStatusBar({ position, language, tabSize, status, synced, peerCount }) {
  const sync = status === 'connected' && !synced ? SYNC_COPY.connecting : SYNC_COPY[status]
  const state = sync || SYNC_COPY.connecting

  return (
    <footer className="statusbar" role="status" aria-live="polite">
      <span className="statusbar__item nums" title="Cursor position">
        Ln {position.line}, Col {position.column}
      </span>

      {position.selected > 0 && (
        <span className="statusbar__item nums">{position.selected} selected</span>
      )}

      <span className="statusbar__spacer" />

      <span className="statusbar__item nums">Spaces: {tabSize}</span>
      <span className="statusbar__item">UTF-8</span>
      <span className="statusbar__item">{language}</span>

      <span className={'statusbar__item statusbar__item--' + state.tone}>
        <Icon name={state.icon} size={12} />
        {state.label}
      </span>

      <span className="statusbar__item" title="People in this room">
        <Icon name="users" size={12} />
        <span className="nums">{peerCount + 1}</span>
      </span>
    </footer>
  )
}
