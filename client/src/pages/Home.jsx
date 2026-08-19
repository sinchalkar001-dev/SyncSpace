import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { nanoid } from 'nanoid'
import { useAuth } from '../auth/useAuth.js'
import { Field } from '../components/ui/Field.jsx'
import { Spinner } from '../components/ui/Spinner.jsx'

/**
 * Guest entry point. Signed-in users go straight to their dashboard; everyone
 * else can still open a public room without an account.
 */
export default function Home() {
  const { isAuthenticated, isLoading, identity, renameGuest } = useAuth()
  const navigate = useNavigate()
  const [code, setCode] = useState('')

  if (isLoading) {
    return (
      <div className="route-loading">
        <Spinner label="Loading" />
      </div>
    )
  }

  if (isAuthenticated) return <Navigate to="/dashboard" replace />

  const onCreate = (event) => {
    event.preventDefault()
    navigate('/room/' + nanoid(8))
  }

  const onJoin = (event) => {
    event.preventDefault()
    const trimmed = code.trim()
    if (trimmed) navigate('/room/' + encodeURIComponent(trimmed))
  }

  return (
    <main className="landing">
      <div className="landing__card">
        <div className="landing__brand">
          <span className="brand-mark brand-mark--lg">SS</span>
          <div>
            <h1>SyncSpace</h1>
            <p className="landing__tagline">
              A shared whiteboard and code editor in one room. Every change merges through CRDTs, so
              nobody overwrites anybody.
            </p>
          </div>
        </div>

        <Field
          label="Display name"
          value={identity.name}
          onChange={(event) => renameGuest(event.target.value)}
          maxLength={32}
          hint="This is how others see you on the canvas."
        />

        <form onSubmit={onCreate}>
          <button type="submit" className="btn btn--primary btn--block">
            Start a public room
          </button>
        </form>

        <div className="landing__divider">
          <span>or join an existing one</span>
        </div>

        <form className="landing__join" onSubmit={onJoin}>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Room code"
            aria-label="Room code"
          />
          <button type="submit" className="btn" disabled={!code.trim()}>
            Join
          </button>
        </form>

        <p className="landing__footer">
          <Link to="/login">Sign in</Link> to keep your rooms, invite teammates, and replay past
          sessions.
        </p>
      </div>
    </main>
  )
}
