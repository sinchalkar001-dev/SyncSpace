import { useEffect, useState } from 'react'
import { createCollabSession } from '../lib/collab.js'

/**
 * Owns the Yjs document + provider for a room.
 *
 * The session is rebuilt only when the room changes; identity updates are
 * pushed through awareness by a separate effect so renaming yourself does not
 * tear down the socket.
 */
export function useCollabSession(roomId, user) {
  const [session, setSession] = useState(null)
  const [status, setStatus] = useState('connecting')
  const [synced, setSynced] = useState(false)
  const [authError, setAuthError] = useState(null)

  useEffect(() => {
    if (!roomId) return undefined

    const active = createCollabSession({ roomId, user })
    setSession(active)
    setStatus('connecting')
    setSynced(false)
    setAuthError(null)

    const onStatus = (event) => setStatus(event.status)
    const onSynced = () => setSynced(true)
    const onDisconnect = () => setSynced(false)
    const onAuthFailed = (event) => setAuthError(event?.reason || 'Authentication failed')

    active.provider.on('status', onStatus)
    active.provider.on('synced', onSynced)
    active.provider.on('disconnect', onDisconnect)
    active.provider.on('authenticationFailed', onAuthFailed)

    return () => {
      active.provider.off('status', onStatus)
      active.provider.off('synced', onSynced)
      active.provider.off('disconnect', onDisconnect)
      active.provider.off('authenticationFailed', onAuthFailed)
      active.destroy()
      setSession(null)
      setSynced(false)
    }
    // `user` is intentionally excluded: see the awareness effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])

  useEffect(() => {
    if (!session) return
    session.provider.setAwarenessField('user', user)
  }, [session, user])

  return { session, status, synced, authError }
}
