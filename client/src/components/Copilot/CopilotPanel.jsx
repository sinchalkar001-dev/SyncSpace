import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icon.jsx'
import { Button } from '../ui/Button.jsx'
import { Spinner } from '../ui/Spinner.jsx'
import { formatWhen } from '../../lib/rooms.js'
import { actionsIn, blockerFor, detectContext, inputFor } from '../../lib/copilot.js'
import { CopilotAnswer } from './CopilotAnswer.jsx'
import { CopilotReview } from './CopilotReview.jsx'

/**
 * The copilot, as a docked panel rather than a dialog or a chat.
 *
 * Three decisions shape this, and all three are about it being a tool rather
 * than a conversation.
 *
 * It does not cover the room. A dialog would mean reading an answer about the
 * code with the code hidden behind it, which is exactly backwards — so this is
 * a drawer, and the room stays usable while an answer arrives.
 *
 * There is no message box. The actions are a list of things a colleague could
 * be asked, each with what it would read, because a blank prompt makes the
 * user responsible for knowing what the tool can do. The optional note is
 * underneath, for the case an action almost fits.
 *
 * And it follows what you are doing. The context is detected — a selection, a
 * failed run, an open replay — and can be overridden, with the override held
 * until the panel closes. Guessing and then refusing to be corrected would be
 * worse than not guessing.
 */

const CONTEXT_HINT = {
  whiteboard: 'Reads the components and connections drawn on the board.',
  code: 'Reads the shared buffer, and narrows to your selection when you have one.',
  execution: 'Reads what happened when the code last ran.',
  replay: 'Reads the session’s history and the point you are paused on.',
  room: 'Reads the session as a whole: what was built, run, said and left open.',
}

function History({ runs, onOpen, busy }) {
  if (!runs.length) return null

  return (
    <section className="copilot__history">
      <h6 className="copilot__blocktitle">Asked in this room</h6>
      <ul>
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              className="copilot__historyitem"
              onClick={() => onOpen(run.id)}
              disabled={Boolean(busy) || run.status === 'failed'}
            >
              <span className={'copilot__dot is-' + run.status} aria-hidden="true" />
              <span className="copilot__historytext">
                <strong>{run.answer || (run.status === 'failed' ? run.error : 'No answer')}</strong>
                <span className="muted">
                  {run.requestedByName ?? 'Someone'} · {formatWhen(run.createdAt)}
                  {run.counts?.applied ? ' · ' + run.counts.applied + ' applied' : ''}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function CopilotPanel({
  open,
  onOpenChange,
  copilot,
  signedIn,
  paneMode,
  selection,
  replay,
  lastRun,
  hasRuns,
  focusedSurface,
  buffer,
  onGoToMoment,
}) {
  const { catalogue, current, history, selected, busy } = copilot

  const [override, setOverride] = useState(null)
  const [note, setNote] = useState('')

  const data = catalogue.data
  const enabled = Boolean(data?.enabled)
  const allowed = Boolean(data?.allowed)

  const detected = detectContext({
    paneMode,
    hasSelection: Boolean(selection?.startLine),
    replayOpen: Boolean(replay?.open),
    lastRun,
    focusedSurface,
  })

  const context = override ?? detected

  /**
   * The override lasts as long as the panel is open, and no longer. Somebody
   * who deliberately asked about the whiteboard while writing code should not
   * find the panel still on "whiteboard" an hour later; somebody who closes it
   * and reopens it is starting again.
   */
  useEffect(() => {
    if (!open) {
      setOverride(null)
      setNote('')
    }
  }, [open])

  // Escape closes, unless an answer is still arriving — in which case it stops
  // that first, which is what somebody pressing Escape at a running thing means.
  useEffect(() => {
    if (!open) return undefined

    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (current.state === 'streaming') {
        copilot.stop()
        return
      }
      onOpenChange(false)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, current.state, copilot, onOpenChange])

  const state = useMemo(
    () => ({
      signedIn,
      enabled,
      allowed,
      reason: data?.reason ?? null,
      hasSelection: Boolean(selection?.startLine),
      hasMoment: Boolean(replay?.seq),
      hasRange: Boolean(replay?.fromSeq),
      hasRuns: Boolean(hasRuns),
      busy: current.state === 'streaming',
    }),
    [signedIn, enabled, allowed, data?.reason, selection, replay, hasRuns, current.state]
  )

  const ask = useCallback(
    (action) => {
      copilot.ask(
        inputFor(action, {
          note: note.trim() || undefined,
          selection,
          seq: replay?.seq,
          range: replay?.fromSeq ? { fromSeq: replay.fromSeq, toSeq: replay.toSeq } : null,
          executionId: lastRun?.executionId,
        })
      )
    },
    [copilot, note, selection, replay, lastRun]
  )

  const actions = actionsIn(data?.actions, context)
  const activeAction = data?.actions?.find((entry) => entry.id === current.action) ?? null
  const showingAnswer = current.state !== 'idle'

  return (
    <>
      <button
        type="button"
        className={'presence-menu__trigger' + (open ? ' is-open' : '')}
        aria-label="Engineering copilot"
        aria-expanded={open}
        title="Engineering copilot"
        onClick={() => onOpenChange(!open)}
      >
        <Icon name="sparkle" size={16} />
      </button>

      {/*
        Portalled to the body, not left where it is written.

        The trigger lives in the room's header, and the header carries a
        backdrop filter — which makes it the containing block for anything
        `position: fixed` inside it. A drawer anchored to the viewport would
        instead be anchored to a 52px-tall bar, and `top: var(--bar-h)` with
        `bottom: 0` against that is a negative height: present in the DOM,
        zero pixels on screen. Moving it out is the fix; giving up `fixed`
        would mean the drawer scrolling away with the workspace.
      */}
      {open &&
        createPortal(
          <aside className="copilot" aria-label="Engineering copilot">
            <header className="copilot__head">
              <h3>
                <Icon name="sparkle" size={15} /> Copilot
              </h3>
              <button
                type="button"
                className="copilot__close"
                onClick={() => onOpenChange(false)}
                aria-label="Close the copilot"
              >
                <Icon name="close" size={15} />
              </button>
            </header>

            {/*
            The context strip. Which one is live is shown, and so is the fact
            that it was worked out rather than chosen — a tool that silently
            decides what you are doing is unnerving; one that says so and lets
            you correct it is not.
          */}
            <nav className="copilot__contexts" aria-label="What to ask about">
              {(data?.contexts ?? []).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={'copilot__context' + (entry.id === context ? ' is-on' : '')}
                  aria-pressed={entry.id === context}
                  onClick={() => setOverride(entry.id)}
                  title={entry.detail}
                >
                  <Icon name={entry.icon} size={13} />
                  <span>{entry.label}</span>
                  {entry.id === detected && !override && (
                    <span className="copilot__auto" title="Picked up from what you are doing">
                      ●
                    </span>
                  )}
                </button>
              ))}
            </nav>

            <div className="copilot__body">
              {catalogue.state === 'loading' && (
                <p className="muted">
                  <Spinner /> Checking what the copilot can do here…
                </p>
              )}

              {catalogue.state === 'error' && (
                <div className="banner banner--error" role="alert">
                  <Icon name="alert" size={15} className="banner__icon" />
                  <span>Could not check whether the copilot is available. {catalogue.error}</span>
                </div>
              )}

              {catalogue.state === 'ready' && !enabled && (
                <div className="empty">
                  <span className="empty__icon">
                    <Icon name="sparkle" size={22} />
                  </span>
                  <h4>The copilot is not available here</h4>
                  <p className="muted">{data.reason}</p>
                </div>
              )}

              {catalogue.state === 'ready' && enabled && !showingAnswer && (
                <>
                  <p className="copilot__hint muted">{CONTEXT_HINT[context]}</p>

                  <ul className="copilot__actions">
                    {actions.map((action) => {
                      const blocker = blockerFor(action, state)

                      return (
                        <li key={action.id}>
                          <button
                            type="button"
                            className="copilot__action"
                            onClick={() => ask(action)}
                            disabled={Boolean(blocker)}
                            title={blocker ?? action.detail}
                          >
                            <Icon name={action.icon} size={15} className="copilot__actionicon" />
                            <span className="copilot__actiontext">
                              <strong>{action.title}</strong>
                              <span className="muted">{blocker ?? action.detail}</span>
                            </span>
                            {action.apply && (
                              <span
                                className="copilot__applies"
                                title={
                                  action.apply === 'code'
                                    ? 'Can propose a change to the code, for you to review'
                                    : 'Can propose files, for you to review'
                                }
                              >
                                <Icon name={action.apply === 'code' ? 'code' : 'file'} size={11} />
                              </span>
                            )}
                          </button>
                        </li>
                      )
                    })}
                  </ul>

                  {/*
                  One optional line, not a chat box. It is for the case where an
                  action almost fits — "focus on the error handling" — rather
                  than an invitation to type the question yourself.
                */}
                  <label className="copilot__note">
                    <span className="field__label">Anything to add (optional)</span>
                    <input
                      className="input"
                      maxLength={2000}
                      value={note}
                      disabled={!allowed}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="e.g. focus on the error handling"
                    />
                  </label>

                  <History runs={history} onOpen={copilot.open} busy={busy} />
                </>
              )}

              {showingAnswer && (
                <>
                  <div className="copilot__answerhead">
                    <Button size="sm" icon="arrow" onClick={copilot.clear}>
                      Back
                    </Button>
                    <strong>{activeAction?.title ?? current.action}</strong>
                    {current.state === 'streaming' && (
                      <Button size="sm" onClick={copilot.stop}>
                        Stop
                      </Button>
                    )}
                  </div>

                  {current.state === 'error' && (
                    <div className="banner banner--error" role="alert">
                      <Icon name="alert" size={15} className="banner__icon" />
                      <span>{current.error}</span>
                    </div>
                  )}

                  <CopilotAnswer
                    action={activeAction}
                    state={current}
                    run={current.run}
                    onGoToMoment={onGoToMoment}
                  />

                  <CopilotReview
                    run={current.run}
                    buffer={buffer}
                    selected={selected}
                    busy={busy}
                    onToggle={copilot.toggle}
                    onSetAll={copilot.setAll}
                    onApplyFiles={copilot.applyFiles}
                    onApplyCode={() => copilot.applyCode(buffer)}
                    onRejectCode={copilot.rejectCode}
                  />
                </>
              )}
            </div>
          </aside>,
          document.body
        )}
    </>
  )
}
