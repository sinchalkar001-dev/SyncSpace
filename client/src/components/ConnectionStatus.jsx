const COPY = {
  connecting: 'Connecting',
  connected: 'Connected',
  disconnected: 'Offline',
}

/**
 * `connected` means the socket is up; `synced` means this client has received
 * the room's document state. Edits made before sync still merge on arrival.
 */
export function ConnectionStatus({ status, synced }) {
  const settling = status === 'connected' && !synced
  const state = settling ? 'connecting' : status
  const label = settling ? 'Syncing' : COPY[status] || status

  return (
    <span
      className={'status status--' + state}
      /* Polite rather than assertive: a reconnect is worth knowing about, but
         should not interrupt whatever the user is doing. */
      role="status"
      aria-live="polite"
      /* The visible label collapses to the dot on small screens, so name the
         status explicitly rather than leaving it as a bare coloured circle. */
      aria-label={label}
      title={label}
    >
      <span className="status__dot" aria-hidden="true" />
      <span className="status__label">{label}</span>
    </span>
  )
}
