import { useEffect, useRef, useState } from 'react'
import { Modal } from './ui/Modal.jsx'

/** Names a room, or renames one that was created without a name. */
export function RenameRoomDialog({ room, open, onClose, onSubmit }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  const unnamed = !room?.name || room.name === 'Untitled room'

  useEffect(() => {
    if (open) setValue(unnamed ? '' : room.name)
  }, [open, room, unnamed])

  const submit = async (event) => {
    event.preventDefault()
    const name = value.trim()
    if (!name || busy) return

    setBusy(true)
    try {
      await onSubmit(name)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={unnamed ? 'Name this room' : 'Rename room'}
      description={room ? 'Room ' + room.roomId : undefined}
      onClose={onClose}
      initialFocusRef={inputRef}
    >
      <form onSubmit={submit}>
        <label className="field">
          <span className="field__label">Room name</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Candidate screen, Sprint planning…"
            maxLength={80}
            aria-label="Room name"
          />
        </label>

        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={!value.trim() || busy}>
            {busy ? 'Saving…' : 'Save name'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
