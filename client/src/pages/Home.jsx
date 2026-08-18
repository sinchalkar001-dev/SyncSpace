import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { nanoid } from 'nanoid'
import { loadIdentity, renameIdentity } from '../lib/identity.js'

export default function Home() {
  const navigate = useNavigate()
  const [name, setName] = useState(() => loadIdentity().name)
  const [roomId, setRoomId] = useState('')

  const enter = (target) => {
    renameIdentity(name)
    navigate('/room/' + target)
  }

  const onCreate = (event) => {
    event.preventDefault()
    enter(nanoid(8))
  }

  const onJoin = (event) => {
    event.preventDefault()
    const trimmed = roomId.trim()
    if (trimmed) enter(encodeURIComponent(trimmed))
  }

  return (
    <main className="home">
      <div className="home__card">
        <div className="home__brand">
          <span className="home__mark">SS</span>
          <div>
            <h1>SyncSpace</h1>
            <p className="home__tagline">
              A shared whiteboard and code editor in one room. Every change merges through CRDTs,
              so nobody overwrites anybody.
            </p>
          </div>
        </div>

        <label className="field">
          <span className="field__label">Display name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="How should others see you?"
            maxLength={32}
          />
        </label>

        <div className="home__actions">
          <form onSubmit={onCreate}>
            <button type="submit" className="btn btn--primary btn--block">
              Create a new room
            </button>
          </form>

          <div className="home__divider">
            <span>or join an existing one</span>
          </div>

          <form className="home__join" onSubmit={onJoin}>
            <input
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
              placeholder="Room code"
              aria-label="Room code"
            />
            <button type="submit" className="btn" disabled={!roomId.trim()}>
              Join
            </button>
          </form>
        </div>
      </div>
    </main>
  )
}
