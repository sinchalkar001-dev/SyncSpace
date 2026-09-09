import { useEffect, useId, useRef, useState } from 'react'
import { Modal } from './ui/Modal.jsx'
import { Button } from './ui/Button.jsx'
import { ROOM_KINDS } from '../lib/rooms.js'

const MAX_NAME = 80
const MAX_DESCRIPTION = 280

/**
 * Starting a room, with enough said about it to find again.
 *
 * Creation used to be a single name field, which is why so many dashboards end
 * up as a wall of rooms called "test" and "Untitled room". Asking for the type
 * at the moment somebody knows the answer — they are about to run an interview,
 * that is why they are here — is the difference between a dashboard that can be
 * filtered and one that cannot.
 *
 * Everything but the name is optional, and the name has a default, so the fast
 * path is still open: Enter creates a room.
 */
export function NewRoomDialog({ open, onClose, onSubmit }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState('general')
  const [busy, setBusy] = useState(false)

  const inputRef = useRef(null)
  const nameId = useId()
  const descriptionId = useId()
  const kindId = useId()

  // Reset on open rather than on close: a dialog that clears itself while
  // fading out is a dialog somebody watches forget what they typed.
  useEffect(() => {
    if (!open) return
    setName('')
    setDescription('')
    setKind('general')
  }, [open])

  const submit = async (event) => {
    event.preventDefault()
    if (busy) return

    setBusy(true)
    try {
      await onSubmit({
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        kind,
      })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="Start a room"
      description="Private by default. Invite people once you are inside."
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
              {name.length}/{MAX_NAME}
            </span>
          </div>
          <div className="field__wrap">
            <input
              id={nameId}
              className="input"
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Candidate screen, Sprint planning…"
              maxLength={MAX_NAME}
            />
          </div>
        </div>

        <div className="field">
          <div className="field__head">
            <label className="field__label" htmlFor={kindId}>
              Room type
            </label>
          </div>
          <div className="field__wrap">
            <select
              id={kindId}
              className="input"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              {ROOM_KINDS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <div className="field__head">
            <label className="field__label" htmlFor={descriptionId}>
              Description <span className="muted">(optional)</span>
            </label>
            <span className="field__counter">
              {description.length}/{MAX_DESCRIPTION}
            </span>
          </div>
          <div className="field__wrap">
            <textarea
              id={descriptionId}
              className="input"
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What is this room for? One line is plenty."
              maxLength={MAX_DESCRIPTION}
            />
          </div>
        </div>

        <div className="modal__actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="plus" loading={busy}>
            Create room
          </Button>
        </div>
      </form>
    </Modal>
  )
}
