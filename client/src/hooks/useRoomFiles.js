import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { useToast } from '../components/ui/useToast.js'

/**
 * The files shared in a room, and the four things you can do with them.
 *
 * Every route behind this is `requireAuth`, so a guest in a public room cannot
 * use files at all — hence `enabled`, which keeps the panel from firing a
 * request that can only ever be refused.
 */

/** Matches the server's cap; asking for more is silently trimmed anyway. */
const PAGE = 50

export function useRoomFiles(roomId, { enabled = true } = {}) {
  const toast = useToast()
  const [state, setState] = useState(enabled ? 'loading' : 'idle')
  const [files, setFiles] = useState([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState(null)

  // Which row is mid-request, so only that row shows a spinner. 'upload' while
  // something is being shared, a file id while it is being fetched or removed.
  const [pending, setPending] = useState(null)

  const load = useCallback(
    (signal) =>
      api.listFiles(roomId, { limit: PAGE }, signal).then(
        (payload) => {
          setFiles(payload.files ?? [])
          setTotal(payload.total ?? 0)
          setState('ready')
        },
        (cause) => {
          if (cause?.name === 'AbortError') return
          setError(cause.message)
          setState('error')
        }
      ),
    [roomId]
  )

  useEffect(() => {
    if (!enabled || !roomId) return undefined

    const controller = new AbortController()
    setState('loading')
    setError(null)
    load(controller.signal)

    return () => controller.abort()
  }, [enabled, roomId, load])

  /**
   * Shares one file.
   *
   * The list is re-read rather than patched: the server decides the id, the
   * stored name and the timestamp, and a row invented here would disagree with
   * the one everyone else sees.
   */
  const upload = useCallback(
    async (file) => {
      if (!file) return false
      setPending('upload')
      try {
        await api.uploadFile(roomId, file)
        await load()
        toast.success(file.name + ' shared with the room')
        return true
      } catch (cause) {
        toast.error(cause.message)
        return false
      } finally {
        setPending(null)
      }
    },
    [roomId, load, toast]
  )

  /**
   * Saves a file to disk.
   *
   * The bytes come back over an authenticated request and are handed to the
   * browser from memory, because the download route needs a bearer token and a
   * plain link cannot carry one.
   */
  const download = useCallback(
    async (file) => {
      setPending(file.id)
      let url = null
      try {
        const blob = await api.downloadFile(roomId, file.id)
        url = URL.createObjectURL(blob)

        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = file.originalName
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        return true
      } catch (cause) {
        toast.error(cause.message)
        return false
      } finally {
        // Revoked on the next tick: Chrome cancels an in-flight save if the
        // object URL disappears in the same frame as the click.
        if (url) setTimeout(() => URL.revokeObjectURL(url), 0)
        setPending(null)
      }
    },
    [roomId, toast]
  )

  const remove = useCallback(
    async (file) => {
      setPending(file.id)
      try {
        await api.deleteFile(roomId, file.id)
        await load()
        toast.success(file.originalName + ' was removed')
        return true
      } catch (cause) {
        toast.error(cause.message)
        return false
      } finally {
        setPending(null)
      }
    },
    [roomId, load, toast]
  )

  return { state, files, total, error, pending, reload: load, upload, download, remove }
}
