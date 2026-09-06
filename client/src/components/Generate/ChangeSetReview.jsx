import { useState } from 'react'
import { Icon } from '../ui/Icon.jsx'
import { Button } from '../ui/Button.jsx'

/**
 * Reviewing what the model proposed, one file at a time.
 *
 * Nothing here applies anything on its own. Every file starts ticked but
 * nothing is written until Apply, and what is left unticked is recorded as
 * rejected rather than left undecided — so the change set always says what a
 * person concluded, which is the difference between a record and a draft.
 *
 * A modification shows what it would replace. That is the whole meaning of
 * "do not blindly overwrite": the server has already refused to treat a
 * proposed create as new when the room has that file, and this is where the
 * person sees the thing they would be losing.
 */

const ACTION_LABEL = { create: 'New file', modify: 'Replaces', delete: 'Deletes' }
const ACTION_ICON = { create: 'plus', modify: 'pen', delete: 'trash' }

const formatBytes = (size) =>
  size < 1024 ? size + ' B' : (size / 1024).toFixed(size < 10240 ? 1 : 0) + ' kB'

function FileRow({ file, checked, disabled, onToggle }) {
  const [open, setOpen] = useState(false)
  const decided = file.status !== 'proposed'

  return (
    <li className={'changeset__file is-' + file.action + (decided ? ' is-decided' : '')}>
      <div className="changeset__row">
        <label className="changeset__pick">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled || decided}
            onChange={() => onToggle(file.id)}
            aria-label={'Accept ' + file.path}
          />
          <span className={'changeset__action changeset__action--' + file.action}>
            <Icon name={ACTION_ICON[file.action]} size={12} />
            {ACTION_LABEL[file.action]}
          </span>
          <code className="changeset__path">{file.path}</code>
        </label>

        <span className="changeset__meta">
          {file.status === 'applied' && (
            <span className="changeset__status is-applied">
              <Icon name="checkCircle" size={12} /> Applied
            </span>
          )}
          {file.status === 'rejected' && <span className="changeset__status">Rejected</span>}
          {file.action !== 'delete' && <span className="muted">{formatBytes(file.size)}</span>}
          <Button
            size="sm"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            icon={open ? 'chevronUp' : 'chevronDown'}
          >
            {open ? 'Hide' : 'View'}
          </Button>
        </span>
      </div>

      {file.rationale && <p className="changeset__why muted">{file.rationale}</p>}

      {file.error && (
        <p className="changeset__error" role="alert">
          <Icon name="alert" size={12} /> {file.error}
        </p>
      )}

      {open && (
        <div className="changeset__body">
          {file.action === 'modify' && file.previous != null && (
            <>
              <h6 className="changeset__side">This would replace</h6>
              <pre className="changeset__code changeset__code--old">
                <code>{file.previous}</code>
              </pre>
              <h6 className="changeset__side">With</h6>
            </>
          )}

          {file.action === 'delete' ? (
            <p className="muted">
              This file would be removed from the room. Nothing is written in its place.
            </p>
          ) : (
            <pre className="changeset__code">
              <code>{file.contents}</code>
            </pre>
          )}
        </div>
      )}
    </li>
  )
}

export function ChangeSetReview({
  generation,
  selected,
  busy,
  onToggle,
  onSetAll,
  onApply,
  onBack,
  onClose,
}) {
  const files = generation.files
  const pending = files.filter((file) => file.status === 'proposed')
  const applied = files.filter((file) => file.status === 'applied')
  const chosen = pending.filter((file) => selected.has(file.id))

  const grouped = ['create', 'modify', 'delete'].map((action) => ({
    action,
    files: files.filter((file) => file.action === action),
  }))

  return (
    <div className="changeset">
      <div className="changeset__head">
        <Button size="sm" icon="arrow" onClick={onBack}>
          Back
        </Button>
        <div>
          <h4>{generation.summary || 'Proposed implementation'}</h4>
          <p className="muted">
            {generation.requestedByName ? generation.requestedByName + ' · ' : ''}
            {generation.targets.join(', ')}
            {generation.model ? ' · ' + generation.model : ''}
          </p>
        </div>
      </div>

      {generation.plan?.length > 0 && (
        <section className="changeset__section">
          <h5>Plan</h5>
          <ol className="changeset__plan">
            {generation.plan.map((step, index) => (
              <li key={index}>
                <strong>{step.step}</strong>
                {step.detail && <span className="muted"> — {step.detail}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/*
        Assumptions and questions are given the same weight as the code. A
        generated file that quietly assumed PostgreSQL is only safe to accept
        if the assumption is in front of the person accepting it.
      */}
      {generation.assumptions?.length > 0 && (
        <section className="changeset__section">
          <h5>
            <Icon name="info" size={13} /> Assumptions the diagram did not specify
          </h5>
          <ul className="changeset__list">
            {generation.assumptions.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      {generation.questions?.length > 0 && (
        <section className="changeset__section changeset__section--ask">
          <h5>
            <Icon name="alert" size={13} /> Still missing
          </h5>
          <ul className="changeset__list">
            {generation.questions.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
          <p className="muted">
            Answer these on the board or in the instructions box, then generate again.
          </p>
        </section>
      )}

      {generation.rejected?.length > 0 && (
        <section className="changeset__section">
          <h5>What this server changed or refused</h5>
          <ul className="changeset__list muted">
            {generation.rejected.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="changeset__section">
        <div className="changeset__toolbar">
          <h5>
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </h5>
          {pending.length > 0 && (
            <span className="changeset__bulk">
              <Button size="sm" onClick={() => onSetAll(true)} disabled={Boolean(busy)}>
                Select all
              </Button>
              <Button size="sm" onClick={() => onSetAll(false)} disabled={Boolean(busy)}>
                Select none
              </Button>
            </span>
          )}
        </div>

        {files.length === 0 ? (
          <p className="muted">
            This generation produced no files. The questions above are usually why.
          </p>
        ) : (
          grouped
            .filter((group) => group.files.length > 0)
            .map((group) => (
              <div key={group.action} className="changeset__group">
                <h6>
                  {group.action === 'create'
                    ? 'Files to create'
                    : group.action === 'modify'
                      ? 'Files to modify'
                      : 'Files to delete'}{' '}
                  <span className="muted">({group.files.length})</span>
                </h6>
                <ul className="changeset__files">
                  {group.files.map((file) => (
                    <FileRow
                      key={file.id}
                      file={file}
                      checked={selected.has(file.id)}
                      disabled={Boolean(busy)}
                      onToggle={onToggle}
                    />
                  ))}
                </ul>
              </div>
            ))
        )}
      </section>

      {/*
        A way out is offered in both states. The dialog itself has no close
        control — only Escape and the backdrop — so a reviewed change set with
        nothing but a summary line would leave somebody looking for the exit.
      */}
      {pending.length > 0 ? (
        <div className="changeset__apply">
          <p className="muted">
            {chosen.length === 0
              ? 'Nothing is selected. Applying will record the whole change set as rejected.'
              : chosen.length +
                ' of ' +
                pending.length +
                ' will be written into this room’s files. The rest will be recorded as rejected.'}
          </p>
          <span className="changeset__buttons">
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" icon="check" loading={busy === 'apply'} onClick={onApply}>
              {chosen.length === 0 ? 'Reject all' : 'Apply ' + chosen.length}
            </Button>
          </span>
        </div>
      ) : (
        <div className="changeset__apply">
          <p className="changeset__done muted">
            <Icon name="checkCircle" size={13} /> Reviewed
            {applied.length > 0 ? ' — ' + applied.length + ' written into this room' : ''}.
          </p>
          <span className="changeset__buttons">
            <Button onClick={onBack}>Back</Button>
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </span>
        </div>
      )}
    </div>
  )
}
