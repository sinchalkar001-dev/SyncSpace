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
  const state = status === 'connected' && !synced ? 'connecting' : status
  const label = status === 'connected' && !synced ? 'Syncing' : COPY[status] || status

  return (
    <span className={'status status--' + state}>
      <span className="status__dot" aria-hidden="true" />
      {label}
    </span>
  )
}
