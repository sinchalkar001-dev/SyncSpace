import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { nanoid } from 'nanoid'
import { useAuth } from '../auth/useAuth.js'
import { Field } from '../components/ui/Field.jsx'
import { Button } from '../components/ui/Button.jsx'
import { Icon } from '../components/ui/Icon.jsx'
import { LoadingBlock } from '../components/ui/Spinner.jsx'
import { TopBar, Brand } from '../components/TopBar.jsx'
import { ProductPreview } from '../components/ProductPreview.jsx'

const FEATURES = [
  {
    icon: 'layers',
    title: 'Conflict-free by design',
    body: 'Concurrent edits merge through CRDTs, not last-write-wins. Two people can draw and type at the same time without losing either.',
  },
  {
    icon: 'cursor',
    title: 'See each other work',
    body: 'Live cursors on the canvas and remote carets in the editor, each labelled with the person behind them.',
  },
  {
    icon: 'clock',
    title: 'Nothing is lost',
    body: 'Every update is appended to a log, so a room survives a restart and can be replayed from any point in its history.',
  },
  {
    icon: 'lock',
    title: 'Yours until you share it',
    body: 'Rooms you create are private and invite-only. Make one public and anyone with the link can walk in.',
  },
]

/**
 * Guest entry point and product front door.
 *
 * Signed-in users go straight to their dashboard; everyone else can start or
 * join a public room without an account. Creating and joining stay above the
 * fold — the marketing below them must never push the actual product away.
 */
export default function Home() {
  const { isAuthenticated, isLoading, identity, renameGuest } = useAuth()
  const navigate = useNavigate()

  const [code, setCode] = useState('')
  // Mirrored locally so the field can be emptied while typing; `renameGuest`
  // keeps the previous name rather than storing a blank one.
  const [name, setName] = useState(identity.name)

  if (isLoading) return <LoadingBlock label="Loading" />
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

  const onRename = (event) => {
    setName(event.target.value)
    renameGuest(event.target.value)
  }

  return (
    <div className="landing">
      <TopBar>
        <Brand />
        <div className="topbar__right">
          <Link className="btn btn--ghost" to="/login">
            Sign in
          </Link>
          <Link className="btn btn--primary" to="/register">
            Create an account
          </Link>
        </div>
      </TopBar>

      <main className="landing__body" id="main">
        <section className="hero">
          <span className="badge badge--accent hero__eyebrow">
            <Icon name="zap" size={12} />
            Real-time, no account needed
          </span>

          <h1 className="hero__title">
            Draw and code in the <em>same room</em>.
          </h1>

          <p className="hero__lede">
            A shared whiteboard beside a shared editor. Sketch the architecture on one side, write
            the code on the other, and watch everyone&apos;s changes land as they happen.
          </p>

          {/* Two separate forms rather than one: Enter in the room-code box must
              join that room, not create a brand new one. */}
          <div className="hero__start">
            <Field
              label="Your display name"
              value={name}
              onChange={onRename}
              maxLength={32}
              icon="users"
              showCount
              hint="This is how others see you on the canvas."
            />

            <form onSubmit={onCreate}>
              <Button type="submit" variant="primary" size="lg" block iconAfter="arrowRight">
                Start a public room
              </Button>
            </form>

            <p className="hero__divider">
              <span>or join an existing one</span>
            </p>

            <form className="hero__row" onSubmit={onJoin}>
              <div className="field" style={{ marginBottom: 0, flex: 1 }}>
                <div className="field__wrap">
                  <input
                    className="input"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="Room code"
                    aria-label="Room code"
                  />
                </div>
              </div>
              <Button type="submit" size="lg" disabled={!code.trim()}>
                Join
              </Button>
            </form>
          </div>

          <p className="hero__note">
            <Link to="/login">Sign in</Link> to keep your rooms, invite teammates, and replay past
            sessions.
          </p>
        </section>

        <ProductPreview />

        <section className="features" aria-label="What SyncSpace does">
          {FEATURES.map((feature) => (
            <article className="feature" key={feature.title}>
              <span className="feature__icon">
                <Icon name={feature.icon} size={18} />
              </span>
              <h2 className="feature__title">{feature.title}</h2>
              <p className="feature__body">{feature.body}</p>
            </article>
          ))}
        </section>
      </main>

      <footer className="landing__foot">
        <div className="landing__foot-inner">
          <span>SyncSpace — a collaborative whiteboard and code editor.</span>
          <Link to="/register">Create an account</Link>
        </div>
      </footer>
    </div>
  )
}
