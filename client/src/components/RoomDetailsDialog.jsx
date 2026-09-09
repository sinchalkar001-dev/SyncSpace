import { useEffect, useId, useRef, useState } from 'react'
import { Modal } from './ui/Modal.jsx'
import { Button } from './ui/Button.jsx'
import { isUnnamed, kindOf, ROOM_KINDS } from '../lib/rooms.js'

const MAX_NAME = 80
const MAX_DESCRIPTION = 280

/**
 * What a room is called, what it is for, and what kind of thing it is.
 *
 * One dialog rather than three, because these are one decision: somebody
 * naming a room "Candidate screen" is in exactly the frame of mind to also say
 * it is an interview and what the candidate is being asked. Splitting them
 * across separate menu items would mean opening three dialogs to describe one
 * room.
 *
 * Only what actually changed is sent. That keeps a rename a rename — the
 * request carries `name` and nothing else — so a room's description is never
 * quietly rewritten with its own current value by somebody who came here to
 * fix a typo in the title.
 */
export function RoomDetailsDialog({ room, open, onClose, onSubmit }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState('general')
  const [busy, setBusy] = useState(false)

  const inputRef = useRef(null)
  const nameId = useId()
  const descriptionId = useId()
  const kindId = useId()

  const unnamed = isUnnamed(room)

  useEffect(() => {
    if (!open || !room) return
    setName(unnamed ? '' : room.name)
    setDescription(room.description ?? '')
    setKind(kindOf(room).value)
  }, [open, room, unnamed])

  const submit = async (event) => {
    event.preventDefault()

    const nextName = name.trim()
    if (!nextName || busy) return

    const patch = {}
    if (nextName !== (unnamed ? 'Untitled room' : room.name)) patch.name = nextName
    if (description.trim() !== (room.description ?? '')) patch.description = description.trim()
    if (kind !== kindOf(room).value) patch.kind = kind

    // Nothing to say to the server, so nothing is said. Closing is the honest
    // response to "save" when the form matches what is already stored.
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }

    setBusy(true)
    try {
      await onSubmit(patch)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={unnamed ? 'Name this room' : 'Room details'}
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
            <label className="field__label" htmlFor={descriptionId}>
              Description
            </label>
            <span className="field__counter">
              {description.length}/{MAX_DESCRIPTION}
            </span>
          </div>
          <div className="field__wrap">
            <textarea
              id={descriptionId}
              className="input"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What is this room for? One line is plenty."
              maxLength={MAX_DESCRIPTION}
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

        <div className="modal__actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()} loading={busy}>
            Save changes
          </Button>
        </div>
      </form>
    </Modal>
  )
}
