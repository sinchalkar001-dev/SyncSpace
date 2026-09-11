import { useCallback, useEffect, useMemo, useState } from 'react'
import { useReplay } from '../../hooks/useReplay.js'
import { describeStep, SPEEDS } from '../../lib/replay.js'
import { Button } from '../ui/Button.jsx'
import { Icon } from '../ui/Icon.jsx'
import { Modal } from '../ui/Modal.jsx'
import { Segmented } from '../ui/Segmented.jsx'
import { Spinner } from '../ui/Spinner.jsx'
import { ReplayBoard } from './ReplayBoard.jsx'
import { SessionPanel } from './SessionPanel.jsx'
import { useSessionInsights } from '../../hooks/useSessionInsights.js'
import { indexForSeq } from '../../lib/sessionInsights.js'

const NO_THREADS = []

/**
 * The code as it stood, with the lines that had comments on them marked.
 *
 * Each marked line carries what was said on it, as a tooltip: the replay is
 * for reading, and a mark that cannot say what it marks is only half useful.
 * Without any comments the code is one string, as it always was.
 */
function ReplayCode({ code, threads, anchors }) {
  const marks = useMemo(() => {
    const byLine = new Map()
    for (const thread of threads) {
      const at = anchors.get(thread.id)
      if (!at || at.orphaned) continue
      for (let line = at.line; line <= at.endLine; line += 1) {
        byLine.set(line, [...(byLine.get(line) ?? []), thread])
      }
    }
    return byLine
  }, [threads, anchors])

  if (marks.size === 0) {
    return (
      <pre className="replay__code-body">
        <code>{code}</code>
      </pre>
    )
  }

  return (
    <pre className="replay__code-body">
      <code>
        {code.split('\n').map((text, index) => {
          const here = marks.get(index + 1)
          const said = here
            ?.map((thread) => {
              const first = thread.messages[0]
              return (
                (first?.authorName || 'Someone') +
                ': ' +
                (first?.deleted ? '(deleted)' : first?.body) +
                (thread.status === 'resolved' ? ' (resolved)' : '')
              )
            })
            .join('\n')

          return (
            <span
              key={index}
              className={
                'replay__line' +
                (here ? ' has-comment' : '') +
                (here?.every((thread) => thread.status === 'resolved') ? ' is-resolved' : '')
              }
              title={said}
            >
              {text || ' '}
            </span>
          )
        })}
      </code>
    </pre>
  )
}

/**
 * Watching a room being built.
 *
 * The board and the buffer are shown as they stood at a chosen point in the
 * update log: drag the scrubber to go anywhere, or press play and watch the
 * work arrive in the order it was made.
 *
 * This is deliberately a viewer and not a second editor. Nothing here writes,
 * and nothing here is connected to the live document — the room carries on
 * behind it, and closing returns to it exactly as it was.
 */
export function ReplayViewer({ roomId, onClose, summarizeBlocker = null, comments = NO_THREADS }) {
  const {
    state,
    error,
    entries,
    capped,
    names,
    index,
    frame,
    busy,
    frameError,
    playing,
    speed,
    atEnd,
    setSpeed,
    seek,
    step,
    toggle,
  } = useReplay(roomId, { threads: comments })

  const position = useMemo(() => describeStep(index, entries, names), [index, entries, names])

  const boardThreads = useMemo(
    () =>
      (frame?.threads ?? NO_THREADS).filter(
        (thread) => thread.anchor?.kind === 'shape' || thread.anchor?.kind === 'region'
      ),
    [frame?.threads]
  )

  /**
   * The session panel: a timeline of what happened, a summary of it, and an
   * explanation of the point the replay is paused on.
   *
   * Nothing in it is fetched until it is first opened, and none of it shares
   * a request with the frames above - a slow model call can hold up its own
   * panel and nothing else.
   */
  const [panelOpen, setPanelOpen] = useState(false)
  const insights = useSessionInsights(roomId, { enabled: panelOpen })
  const { summary, moment, summarize, explain, dismissMoment } = insights

  const currentSeq = index > 0 ? (entries[index - 1]?.seq ?? 0) : 0

  const seekToSeq = useCallback((seq) => seek(indexForSeq(entries, seq)), [entries, seek])

  // A summary already written for exactly this history is shown, not asked for again.
  const summaryIsFresh = Boolean(summary.data && summary.current)

  const summarizeHere = useCallback(() => {
    setPanelOpen(true)
    if (summarizeBlocker || summaryIsFresh) return
    summarize()
  }, [summarizeBlocker, summaryIsFresh, summarize])

  const explainHere = useCallback(() => {
    setPanelOpen(true)
    explain(currentSeq)
  }, [explain, currentSeq])

  // Pressing play again means the question about this point is no longer the
  // one being asked, so an answer still being written is abandoned.
  useEffect(() => {
    if (playing && moment.state === 'loading') dismissMoment()
  }, [playing, moment.state, dismissMoment])

  /**
   * Space plays, the arrows step. Skipped whenever a control would act on the
   * key itself: the scrubber already moves on arrows, and a focused button
   * already fires on space.
   */
  const onKeyDown = useCallback(
    (event) => {
      const tag = event.target instanceof HTMLElement ? event.target.tagName : ''
      if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA') return

      if (event.key === ' ') {
        event.preventDefault()
        toggle()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        step(-1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        step(1)
      }
    },
    [step, toggle]
  )

  const lines = frame?.code ? frame.code.split('\n').length : 0

  return (
    <Modal
      open
      full
      title="Room history"
      description="Every change this room has recorded, from the first to the most recent."
      onClose={onClose}
    >
      <div className="replay" onKeyDown={onKeyDown}>
        {state === 'loading' && (
          <div className="replay__notice" role="status">
            <Spinner size="lg" />
            <p className="muted">Reading this room’s history</p>
          </div>
        )}

        {state === 'disabled' && (
          <div className="replay__notice">
            <span className="empty__icon">
              <Icon name="clock" size={22} />
            </span>
            <p>This server is not keeping an update log, so there is no history to replay.</p>
            <p className="muted">
              Rooms still sync and still survive a restart. Set <code>PERSIST_UPDATE_LOG=true</code>{' '}
              to record one from here on.
            </p>
          </div>
        )}

        {state === 'error' && (
          <div className="banner banner--error" role="alert">
            <Icon name="alert" size={15} className="banner__icon" />
            <span>{error}</span>
          </div>
        )}

        {state === 'ready' && entries.length === 0 && (
          <div className="replay__notice">
            <span className="empty__icon">
              <Icon name="clock" size={22} />
            </span>
            <p>Nothing has been recorded in this room yet.</p>
            <p className="muted">
              Draw something or type in the editor, and every change from that moment on can be
              replayed here.
            </p>
          </div>
        )}

        {state === 'ready' && entries.length > 0 && (
          <>
            <div className={'replay__body' + (panelOpen ? ' replay__body--panel' : '')}>
              <div className="replay__panes">
                <ReplayBoard shapes={frame?.shapes ?? []} threads={boardThreads} />

                <div className="replay__code">
                  <header className="replay__code-head">
                    <Icon name="code" size={14} />
                    <span>Code</span>
                    <span className="muted nums">
                      {frame?.code ? lines + (lines === 1 ? ' line' : ' lines') : 'empty'}
                    </span>
                  </header>

                  {frame?.code ? (
                    <ReplayCode
                      code={frame.code}
                      threads={frame.threads ?? NO_THREADS}
                      anchors={frame.codeAnchors ?? new Map()}
                    />
                  ) : (
                    <p className="replay__blank muted">Nothing had been typed yet.</p>
                  )}
                </div>
              </div>

              {panelOpen && (
                <SessionPanel
                  insights={insights}
                  blocker={summarizeBlocker}
                  currentSeq={currentSeq}
                  onSeek={seekToSeq}
                  onClose={() => setPanelOpen(false)}
                />
              )}
            </div>

            {frameError && (
              <div className="banner banner--error" role="alert">
                <Icon name="alert" size={15} className="banner__icon" />
                <span>{frameError}</span>
              </div>
            )}

            <div className="replay__transport">
              <Button
                variant="primary"
                icon={playing ? 'pause' : 'play'}
                onClick={toggle}
                aria-label={playing ? 'Pause' : atEnd ? 'Play from the beginning' : 'Play'}
              />
              <Button
                icon="skipBack"
                onClick={() => step(-1)}
                disabled={index === 0}
                aria-label="One change back"
              />
              <Button
                icon="skipForward"
                onClick={() => step(1)}
                disabled={atEnd}
                aria-label="One change forward"
              />

              <input
                className="replay__scrub"
                type="range"
                min={0}
                max={entries.length}
                step={1}
                value={index}
                onChange={(event) => seek(event.target.value)}
                aria-label="Position in history"
                aria-valuetext={
                  index === 0
                    ? 'Before the first change'
                    : 'Change ' + index + ' of ' + entries.length + ', by ' + position.title
                }
              />

              <span className="replay__count nums">
                {index} / {entries.length}
              </span>
            </div>

            <div className="replay__meta">
              <span className="replay__who">
                <strong className="replay__actor">{position.title}</strong>
                {position.detail && <span className="muted"> · {position.detail}</span>}
              </span>

              {/* Only while it matters: a spinner on every cached step would
                  flicker through a replay that is running perfectly well. */}
              {busy && <Spinner label="Loading this point in the history" />}

              <Segmented
                options={SPEEDS}
                value={speed}
                onChange={setSpeed}
                label="Playback speed"
                size="sm"
              />

              {/* Offered only while paused: a moment is somewhere you stop, and
                  asking about one mid-playback would explain a frame that has
                  already gone by the time the answer arrives. */}
              {!playing && index > 0 && (
                <Button
                  size="sm"
                  icon="info"
                  onClick={explainHere}
                  disabled={Boolean(summarizeBlocker)}
                  title={summarizeBlocker || 'Explain what was happening at this point'}
                >
                  Explain this moment
                </Button>
              )}

              {/* Somebody who cannot spend a model call still gets the
                  timeline, which costs nothing - the button just says so. */}
              <Button
                size="sm"
                variant={panelOpen ? 'primary' : 'default'}
                icon={summarizeBlocker ? 'activity' : 'zap'}
                onClick={summarizeHere}
                aria-pressed={panelOpen}
                title={summarizeBlocker || undefined}
              >
                {summarizeBlocker ? 'Session timeline' : 'Summarize session'}
              </Button>
            </div>

            {capped && (
              <p className="replay__note muted">
                Showing the first {entries.length.toLocaleString()} changes. Anything past that is
                not in this scrubber.
              </p>
            )}
          </>
        )}

        <div className="modal__actions">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  )
}
