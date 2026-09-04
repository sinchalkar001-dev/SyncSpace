import { useCallback, useRef, useState } from 'react'
import { useDismissable } from '../hooks/useDismissable.js'
import { useRoomFiles } from '../hooks/useRoomFiles.js'
import { formatWhen } from '../lib/rooms.js'
import { Button } from './ui/Button.jsx'
import { Icon } from './ui/Icon.jsx'
import { Skeleton } from './ui/Skeleton.jsx'
import { ACCEPTS, formatSize, iconFor, MAX_BYTES, rejectionFor } from '../lib/files.js'

/**
 * Everything shared in a room.
 *
 * The backend has had upload, list, download and delete since it was written,
 * and nothing in the app called any of it — so the only way to get a design or
 * a stack trace in front of the person you were working with was to paste it
 * into the code buffer.
 *
 * Every route here needs an account, so a guest sees the button explain that
 * rather than a panel that can only fail.
 */
export function FilesPanel({ roomId, user, canUse = true }) {
  const [open, setOpen] = useState(false)
  const [rejected, setRejected] = useState(null)
  const containerRef = useRef(null)
  const triggerRef = useRef(null)
  const inputRef = useRef(null)

  const close = useCallback(() => setOpen(false), [])
  useDismissable(open, close, { containerRef, triggerRef, captureEscape: true })

  const { state, files, total, error, pending, upload, download, remove } = useRoomFiles(roomId, {
    enabled: open && canUse,
  })

  const choose = async (event) => {
    const file = event.target.files?.[0]
    // Cleared immediately so picking the same file twice still fires a change.
    event.target.value = ''
    if (!file) return

    const why = rejectionFor(file)
    setRejected(why)
    if (why) return

    await upload(file)
  }

  const label = 'Files' + (total > 0 ? ' (' + total + ')' : '')

  return (
    <div className="presence-menu" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="presence-menu__trigger"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="layers" size={16} />
        {total > 0 && <span className="chat__badge">{total > 9 ? '9+' : total}</span>}
      </button>

      {open && (
        <div className="presence-menu__panel files" role="dialog" aria-label="Room files">
          <h3 className="people__heading">Files</h3>

          {!canUse && (
            <p className="muted people__empty">
              Sharing files needs an account. Sign in and you can put things here for everyone in
              the room.
            </p>
          )}

          {canUse && (
            <>
              {state === 'loading' && (
                <div className="people__list" aria-hidden="true">
                  {[0, 1].map((row) => (
                    <div key={row} style={{ display: 'flex', gap: 12, padding: 8 }}>
                      <Skeleton variant="circle" width={30} height={30} />
                      <Skeleton width={`${50 + row * 15}%`} />
                    </div>
                  ))}
                </div>
              )}

              {state === 'error' && (
                <div className="banner banner--error" role="alert">
                  <Icon name="alert" size={15} className="banner__icon" />
                  <span>{error}</span>
                </div>
              )}

              {state === 'ready' && files.length === 0 && (
                <p className="muted people__empty">
                  Nothing shared yet. Images, PDFs and text files, up to {formatSize(MAX_BYTES)}.
                </p>
              )}

              {state === 'ready' && files.length > 0 && (
                <ul className="people__list files__list">
                  {files.map((file) => {
                    // Deleting is the uploader's or the owner's to do; the
                    // server enforces it, and offering it to anyone else would
                    // be a button that only ever fails.
                    const mine = user?.id && String(file.userId) === String(user.id)
                    const busy = pending === file.id

                    return (
                      <li key={file.id}>
                        <span className="files__icon" aria-hidden="true">
                          <Icon name={iconFor(file.mimeType)} size={15} />
                        </span>

                        <span className="people__who">
                          <strong className="files__name" title={file.originalName}>
                            {file.originalName}
                          </strong>
                          <span className="muted nums">
                            {formatSize(file.size)} · {formatWhen(file.createdAt)}
                          </span>
                        </span>

                        <Button
                          size="sm"
                          variant="ghost"
                          icon="arrowRight"
                          loading={busy}
                          title={'Save ' + file.originalName}
                          onClick={() => download(file)}
                        >
                          Save
                        </Button>

                        {mine && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="trash"
                            loading={busy}
                            title={'Remove ' + file.originalName}
                            onClick={() => remove(file)}
                          >
                            Remove
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {rejected && (
                <div className="banner banner--error" role="alert">
                  <Icon name="alert" size={15} className="banner__icon" />
                  <span>{rejected}</span>
                </div>
              )}

              <div className="files__add">
                <input
                  ref={inputRef}
                  type="file"
                  className="sr-only"
                  accept={ACCEPTS.join(',')}
                  aria-label="Choose a file to share"
                  onChange={choose}
                />
                <Button
                  variant="primary"
                  icon="plus"
                  loading={pending === 'upload'}
                  onClick={() => inputRef.current?.click()}
                >
                  Share a file
                </Button>
                <p className="people__hint">
                  Images, PDFs and text files, up to {formatSize(MAX_BYTES)}. Everyone in the room
                  can open what you share.
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
