import { useState } from 'react'
import { Modal } from '../ui/Modal.jsx'
import { Button } from '../ui/Button.jsx'
import { Icon } from '../ui/Icon.jsx'
import { Spinner } from '../ui/Spinner.jsx'
import { formatWhen } from '../../lib/rooms.js'
import { ArchitecturePreview } from './ArchitecturePreview.jsx'
import { ChangeSetReview } from './ChangeSetReview.jsx'

/**
 * Generate from whiteboard.
 *
 * Two screens in one dialog: what the board says and what to ask for, then the
 * change set that came back. They are deliberately sequential — the reading
 * comes first because it is the thing worth checking before spending a
 * request, and a change set is too much to review beside a form.
 */

const TARGET_LABELS = {
  backend: 'Backend',
  api: 'API routes',
  database: 'Database models',
  frontend: 'Frontend scaffolding',
}

const DEFAULT_TARGETS = ['backend', 'api', 'database']

function Unavailable({ reason }) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon name="zap" size={22} />
      </span>
      <h4>Generation is not available here</h4>
      <p className="muted">{reason}</p>
      <p className="muted">
        Everything else on this screen still works: the architecture below is read from the board by
        this server, with no model involved.
      </p>
    </div>
  )
}

function History({ items, onOpen, busy }) {
  if (items.length === 0) return null

  return (
    <section className="generate__history">
      <h5>Earlier in this room</h5>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="generate__historyitem"
              onClick={() => onOpen(item.id)}
              disabled={Boolean(busy) || item.status === 'failed'}
            >
              <span className={'generate__dot is-' + item.status} aria-hidden="true" />
              <span className="generate__historytext">
                <strong>{item.summary || (item.status === 'failed' ? 'Failed' : 'Untitled')}</strong>
                <span className="muted">
                  {item.requestedByName ?? 'Someone'} · {formatWhen(item.createdAt)}
                  {item.status === 'succeeded' &&
                    ' · ' + item.counts.total + ' files' +
                      (item.counts.applied ? ', ' + item.counts.applied + ' applied' : '')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function GeneratePanel({ open, onClose, generation: state }) {
  const {
    availability,
    architecture,
    refreshArchitecture,
    generation,
    history,
    selected,
    busy,
    error,
    generate,
    open: openGeneration,
    toggle,
    setAll,
    apply,
    close,
  } = state

  const [targets, setTargets] = useState(DEFAULT_TARGETS)
  const [intent, setIntent] = useState('')

  const canGenerate =
    availability.state === 'ready' &&
    availability.ai?.enabled &&
    architecture.state === 'ready' &&
    (architecture.graph?.nodes.length ?? 0) > 0 &&
    targets.length > 0

  const toggleTarget = (key) =>
    setTargets((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    )

  return (
    <Modal
      open={open}
      title="Generate from whiteboard"
      description={
        generation
          ? 'Review each file before anything is written.'
          : 'The design on the board becomes a proposed implementation. Nothing is written until you accept it.'
      }
      onClose={onClose}
      wide
    >
      {error && (
        <div className="banner banner--error" role="alert">
          <Icon name="alert" size={15} className="banner__icon" />
          <span>{error}</span>
        </div>
      )}

      {generation ? (
        <ChangeSetReview
          generation={generation}
          selected={selected}
          busy={busy}
          onToggle={toggle}
          onSetAll={setAll}
          onApply={apply}
          onBack={close}
          onClose={onClose}
        />
      ) : (
        <div className="generate">
          {availability.state === 'loading' && (
            <p className="muted">
              <Spinner /> Checking what this server can do…
            </p>
          )}

          {availability.state === 'error' && (
            <div className="banner banner--error" role="alert">
              <Icon name="alert" size={15} className="banner__icon" />
              <span>Could not check whether generation is available. {availability.error}</span>
            </div>
          )}

          {availability.state === 'ready' && !availability.ai.enabled && (
            <Unavailable reason={availability.ai.reason} />
          )}

          <ArchitecturePreview
            state={architecture.state}
            graph={architecture.graph}
            error={architecture.error}
            onRetry={refreshArchitecture}
          />

          {availability.ai?.enabled && (
            <>
              <section className="generate__ask">
                <h5>What should it write?</h5>
                <div className="generate__targets">
                  {(availability.ai.targets ?? []).map((target) => (
                    <label
                      key={target.key}
                      className={
                        'generate__target' + (targets.includes(target.key) ? ' is-on' : '')
                      }
                      title={target.description}
                    >
                      <input
                        type="checkbox"
                        checked={targets.includes(target.key)}
                        onChange={() => toggleTarget(target.key)}
                      />
                      <span>{TARGET_LABELS[target.key] ?? target.key}</span>
                    </label>
                  ))}
                </div>

                <label className="generate__intent">
                  <span className="field__label">Anything the diagram cannot say</span>
                  <textarea
                    className="input"
                    rows={3}
                    maxLength={2000}
                    value={intent}
                    onChange={(event) => setIntent(event.target.value)}
                    placeholder="Stack, conventions, constraints — e.g. Express and Mongoose, ES modules, no TypeScript."
                  />
                </label>
              </section>

              <div className="generate__go">
                <p className="muted">
                  {targets.length === 0
                    ? 'Choose at least one thing to generate.'
                    : 'Reads the board on the server, then proposes a change set for you to review.'}
                </p>
                <Button
                  variant="primary"
                  icon="zap"
                  loading={busy === 'generate'}
                  disabled={!canGenerate}
                  onClick={() => generate({ targets, intent })}
                >
                  Generate
                </Button>
              </div>
            </>
          )}

          <History items={history} onOpen={openGeneration} busy={busy} />
        </div>
      )}
    </Modal>
  )
}
