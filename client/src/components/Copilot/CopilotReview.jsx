import { useState } from 'react'
import { Icon } from '../ui/Icon.jsx'
import { Button } from '../ui/Button.jsx'
import { describeChange } from '../../lib/textPatch.js'

/**
 * The only part of the copilot that can change anything, and the part that
 * spends most of its effort refusing to.
 *
 * Two proposals arrive here. A change set, reviewed file by file and written
 * into the room's files. And a replacement for the shared code buffer, which
 * is a different problem: the buffer is a live document that other people are
 * editing, so it shows what would change as lines rather than as a wall of
 * text, and it says plainly when the code has moved on since the model read
 * it. That case is not an error — it is the feature working. A copilot that
 * wins races against the people using it is worse than no copilot.
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
          {/*
            A modification shows what it would replace. This is the whole
            meaning of not overwriting blindly: the server has already refused
            to treat a proposed create as new when the room has that file, and
            this is where the person sees the thing they would be losing.
          */}
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

function FileReview({ run, selected, busy, onToggle, onSetAll, onApply }) {
  const files = run.files
  const pending = files.filter((file) => file.status === 'proposed')
  const applied = files.filter((file) => file.status === 'applied')
  const chosen = pending.filter((file) => selected.has(file.id))

  return (
    <section className="copilot__review">
      <div className="changeset__toolbar">
        <h6 className="copilot__blocktitle">
          {files.length} proposed {files.length === 1 ? 'file' : 'files'}
        </h6>
        {pending.length > 0 && (
          <span className="changeset__bulk">
            <Button size="sm" onClick={() => onSetAll(true)} disabled={Boolean(busy)}>
              All
            </Button>
            <Button size="sm" onClick={() => onSetAll(false)} disabled={Boolean(busy)}>
              None
            </Button>
          </span>
        )}
      </div>

      <ul className="changeset__files">
        {files.map((file) => (
          <FileRow
            key={file.id}
            file={file}
            checked={selected.has(file.id)}
            disabled={Boolean(busy)}
            onToggle={onToggle}
          />
        ))}
      </ul>

      {pending.length > 0 ? (
        <div className="changeset__apply">
          <p className="muted">
            {chosen.length === 0
              ? 'Nothing is selected. Applying records the whole change set as turned down.'
              : chosen.length +
                ' of ' +
                pending.length +
                ' will be written into this room’s files. The rest is recorded as turned down.'}
          </p>
          <Button variant="primary" icon="check" loading={busy === 'apply'} onClick={onApply}>
            {chosen.length === 0 ? 'Turn all down' : 'Apply ' + chosen.length}
          </Button>
        </div>
      ) : (
        <p className="copilot__done muted">
          <Icon name="checkCircle" size={13} /> Reviewed
          {applied.length > 0 ? ' — ' + applied.length + ' written into this room' : ''}.
        </p>
      )}
    </section>
  )
}

/**
 * A proposed change to the shared buffer.
 *
 * Shown as the lines it touches rather than as the whole file, computed by the
 * same function that performs the edit — so what is reviewed is exactly what
 * would happen, not a description of it written separately and free to drift.
 */
function PatchReview({ run, buffer, busy, onApply, onReject }) {
  const [full, setFull] = useState(false)
  const patch = run.patch

  const current = buffer?.toString?.() ?? null
  const stale = current != null && current !== patch.baseText
  const change = describeChange(patch.baseText, patch.contents)
  const decided = patch.status !== 'proposed'

  return (
    <section className="copilot__review">
      <div className="changeset__toolbar">
        <h6 className="copilot__blocktitle">Proposed change to the code</h6>
        <Button size="sm" onClick={() => setFull((open) => !open)} aria-expanded={full}>
          {full ? 'Show the change' : 'Show the whole file'}
        </Button>
      </div>

      {patch.rationale && <p className="changeset__why muted">{patch.rationale}</p>}

      {full ? (
        <pre className="changeset__code">
          <code>{patch.contents}</code>
        </pre>
      ) : (
        <div className="copilot__diff">
          <span className="copilot__diffline muted">from line {change.firstLine}</span>
          {change.removed.map((line, index) => (
            <div key={'r' + index} className="copilot__diffrow is-removed">
              <span aria-hidden="true">−</span>
              <code>{line}</code>
            </div>
          ))}
          {change.added.map((line, index) => (
            <div key={'a' + index} className="copilot__diffrow is-added">
              <span aria-hidden="true">+</span>
              <code>{line}</code>
            </div>
          ))}
        </div>
      )}

      {decided ? (
        <p className="copilot__done muted">
          <Icon name={patch.status === 'applied' ? 'checkCircle' : 'info'} size={13} />{' '}
          {patch.status === 'applied'
            ? 'Applied to the buffer.'
            : patch.status === 'stale'
              ? 'Not applied — the code had moved on by the time this was accepted.'
              : 'Turned down.'}
        </p>
      ) : (
        <div className="changeset__apply">
          {stale ? (
            /*
              Said before the button is pressed, not after. The person can see
              the code changing beside them, and a warning that only appears on
              rejection would read as the feature being broken.
            */
            <p className="copilot__stale" role="status">
              <Icon name="alert" size={13} /> The code has changed since this was written, so it
              cannot be applied. Ask again to work from the code as it is now.
            </p>
          ) : (
            <p className="muted">
              Applied as one edit, in your name — everyone in the room sees it happen, and only the
              lines above change.
            </p>
          )}
          <span className="changeset__buttons">
            <Button onClick={onReject} disabled={Boolean(busy)}>
              Turn down
            </Button>
            <Button
              variant="primary"
              icon="check"
              loading={busy === 'patch'}
              disabled={stale}
              onClick={onApply}
            >
              Apply to the code
            </Button>
          </span>
        </div>
      )}
    </section>
  )
}

export function CopilotReview({ run, buffer, selected, busy, onToggle, onSetAll, onApplyFiles, onApplyCode, onRejectCode }) {
  if (!run) return null

  return (
    <>
      {run.files?.length > 0 && (
        <FileReview
          run={run}
          selected={selected}
          busy={busy}
          onToggle={onToggle}
          onSetAll={onSetAll}
          onApply={onApplyFiles}
        />
      )}

      {run.patch && (
        <PatchReview
          run={run}
          buffer={buffer}
          busy={busy}
          onApply={onApplyCode}
          onReject={onRejectCode}
        />
      )}
    </>
  )
}
