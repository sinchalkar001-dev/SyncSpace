import { useEffect, useId, useRef, useState } from 'react'
import { Modal } from './ui/Modal.jsx'
import { Button } from './ui/Button.jsx'
import { isUnnamed } from '../lib/rooms.js'

const MAX_NAME = 80

/** Names a room, or renames one that was created without a name. */
export function RenameRoomDialog({ room, open, onClose, onSubmit }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)
  const nameId = useId()

  const unnamed = isUnnamed(room)

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
        <div className="field">
          <div className="field__head">
            <label className="field__label" htmlFor={nameId}>
              Room name
            </label>
            <span className="field__counter">
              {value.length}/{MAX_NAME}
            </span>
          </div>
          <div className="field__wrap">
            <input
              id={nameId}
              className="input"
              ref={inputRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Candidate screen, Sprint planning…"
              maxLength={MAX_NAME}
            />
          </div>
        </div>

        <div className="modal__actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!value.trim()} loading={busy}>
            Save name
          </Button>
        </div>
      </form>
    </Modal>
  )
}
