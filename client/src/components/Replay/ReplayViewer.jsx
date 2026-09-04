import { useCallback, useMemo } from 'react'
import { useReplay } from '../../hooks/useReplay.js'
import { describeStep, SPEEDS } from '../../lib/replay.js'
import { Button } from '../ui/Button.jsx'
import { Icon } from '../ui/Icon.jsx'
import { Modal } from '../ui/Modal.jsx'
import { Segmented } from '../ui/Segmented.jsx'
import { Spinner } from '../ui/Spinner.jsx'
import { ReplayBoard } from './ReplayBoard.jsx'

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
export function ReplayViewer({ roomId, onClose }) {
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
  } = useReplay(roomId)

  const position = useMemo(() => describeStep(index, entries, names), [index, entries, names])

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
            <div className="replay__panes">
              <ReplayBoard shapes={frame?.shapes ?? []} />

              <div className="replay__code">
                <header className="replay__code-head">
                  <Icon name="code" size={14} />
                  <span>Code</span>
                  <span className="muted nums">
                    {frame?.code ? lines + (lines === 1 ? ' line' : ' lines') : 'empty'}
                  </span>
                </header>

                {frame?.code ? (
                  <pre className="replay__code-body">
                    <code>{frame.code}</code>
                  </pre>
                ) : (
                  <p className="replay__blank muted">Nothing had been typed yet.</p>
                )}
              </div>
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
