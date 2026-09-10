import { memo, useEffect, useMemo, useRef } from 'react'
import { Button } from '../ui/Button.jsx'
import { Icon } from '../ui/Icon.jsx'
import { Spinner } from '../ui/Spinner.jsx'
import {
  SECTION_LABELS,
  citationsOf,
  currentEventId,
  describeEvent,
  hasStatements,
  iconForKind,
} from '../../lib/sessionInsights.js'

/**
 * Every citation is a way back to the evidence: a time stamp that seeks the
 * replay to the event it names. A statement with nothing behind it never gets
 * this far — the server drops those — so every sentence shown here has at
 * least one of these beside it.
 */
function Citations({ statement, cited, onSeek }) {
  const list = citationsOf(statement, cited)
  if (!list.length) return null

  return (
    <span className="session__cites">
      {list.map((citation) => (
        <button
          key={citation.id}
          type="button"
          className="session__cite nums"
          onClick={() => onSeek(citation.seq)}
          title={citation.text + (citation.detail ? ' · ' + citation.detail : '')}
          aria-label={'Go to ' + citation.clock + ': ' + citation.text}
        >
          {citation.clock}
        </button>
      ))}
    </span>
  )
}

function Statements({ items, cited, onSeek }) {
  return (
    <ul className="session__statements">
      {items.map((statement, index) => (
        <li key={index} className="session__statement">
          <span>{statement.text}</span>
          <Citations statement={statement} cited={cited} onSeek={onSeek} />
        </li>
      ))}
    </ul>
  )
}

/** The count of statements thrown away, said plainly rather than hidden. */
function Discarded({ count }) {
  if (!count) return null
  return (
    <p className="session__note muted">
      {count === 1
        ? 'One statement was left out because it cited nothing that happened.'
        : count + ' statements were left out because they cited nothing that happened.'}
    </p>
  )
}

function SummaryBody({ data, onSeek }) {
  const sections = data?.sections ?? {}
  const cited = data?.cited ?? {}
  const shown = SECTION_LABELS.filter(({ key }) => hasStatements(sections, key))

  return (
    <div className="session__summary">
      {sections.overview && (
        <p className="session__overview">
          {sections.overview.text}
          <Citations statement={sections.overview} cited={cited} onSeek={onSeek} />
        </p>
      )}

      {shown.map(({ key, label }) => (
        <section key={key} className="session__section" aria-label={label}>
          <h4 className="session__heading">{label}</h4>
          <Statements items={sections[key]} cited={cited} onSeek={onSeek} />
        </section>
      ))}

      {!sections.overview && shown.length === 0 && (
        <p className="muted">The model found nothing in the recorded events it could stand behind.</p>
      )}

      <Discarded count={data?.discarded} />
    </div>
  )
}

function MomentBody({ moment, onSeek }) {
  const data = moment.data
  const cited = data?.cited ?? {}

  if (moment.state === 'loading') {
    return (
      <div className="session__loading" role="status">
        <Spinner /> Reading what happened here…
      </div>
    )
  }

  if (moment.state === 'error') {
    return (
      <div className="banner banner--error" role="alert">
        <Icon name="alert" size={15} className="banner__icon" />
        <span>{moment.error}</span>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="session__summary">
      {data.explanation ? (
        <p className="session__overview">
          {data.explanation.text}
          <Citations statement={data.explanation} cited={cited} onSeek={onSeek} />
        </p>
      ) : (
        <p className="muted">The recorded events do not explain this point.</p>
      )}

      {data.context?.length > 0 && (
        <section className="session__section" aria-label="Leading up to it">
          <h4 className="session__heading">Leading up to it</h4>
          <Statements items={data.context} cited={cited} onSeek={onSeek} />
        </section>
      )}

      {data.next?.length > 0 && (
        <section className="session__section" aria-label="Right after">
          <h4 className="session__heading">Right after</h4>
          <Statements items={data.next} cited={cited} onSeek={onSeek} />
        </section>
      )}

      <Discarded count={data.discarded} />
    </div>
  )
}

/**
 * A replay's session: its timeline, a summary of it, and the moment the
 * replay is paused on.
 *
 * The timeline comes first in the code and last on screen deliberately: it is
 * the evidence, and the summary above it is a reading of that evidence that
 * can always be checked against it — every citation scrolls the replay to the
 * event, and the current event is marked as the replay moves.
 */
function SessionPanelBase({ insights, blocker, currentSeq, onSeek, onClose }) {
  const { timeline, summary, moment, ai } = insights
  // Memoised so an empty timeline is the same empty list on every render; a
  // fresh [] each time would recompute the current event on every frame.
  const events = useMemo(() => timeline.data?.events ?? [], [timeline.data])

  const activeId = useMemo(() => currentEventId(events, currentSeq), [events, currentSeq])

  // The current event follows the replay, so the list never hides where it is.
  const listRef = useRef(null)
  useEffect(() => {
    if (!activeId) return
    listRef.current
      ?.querySelector('[data-event="' + activeId + '"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId])

  const reason = blocker || (ai && !ai.enabled ? ai.reason : null)
  const summarising = summary.state === 'loading'

  return (
    <aside className="session" aria-label="Session">
      <header className="session__head">
        <span className="session__title">
          <Icon name="activity" size={14} />
          Session
        </span>
        <Button size="sm" variant="ghost" icon="close" onClick={onClose} aria-label="Close session panel" />
      </header>

      {moment.state !== 'idle' && (
        <section className="session__block session__block--moment" aria-live="polite">
          <div className="session__block-head">
            <h3 className="session__block-title">
              This moment{moment.data?.clock ? ' · ' + moment.data.clock : ''}
            </h3>
            <Button
              size="sm"
              variant="ghost"
              icon="close"
              onClick={insights.dismissMoment}
              aria-label="Dismiss explanation"
            />
          </div>
          <MomentBody moment={moment} onSeek={onSeek} />
        </section>
      )}

      <section className="session__block" aria-live="polite">
        <div className="session__block-head">
          <h3 className="session__block-title">Summary</h3>
          {summary.data && !summary.current && (
            <span className="pill pill--quiet" title="The room has changed since this was written">
              Out of date
            </span>
          )}
        </div>

        {summary.data && <SummaryBody data={summary.data} onSeek={onSeek} />}

        {summary.state === 'error' && (
          <div className="banner banner--error" role="alert">
            <Icon name="alert" size={15} className="banner__icon" />
            <span>{summary.error}</span>
          </div>
        )}

        {summarising ? (
          <div className="session__loading" role="status">
            <Spinner /> Reading the session…
          </div>
        ) : (
          (!summary.data || !summary.current) && (
            <div className="session__action">
              <Button
                variant={summary.data ? 'default' : 'primary'}
                icon="zap"
                onClick={insights.summarize}
                disabled={Boolean(reason) || events.length === 0}
                title={reason || (events.length === 0 ? 'Nothing has happened yet' : undefined)}
              >
                {summary.data ? 'Update summary' : 'Summarize session'}
              </Button>
              {reason && <p className="session__note muted">{reason}</p>}
            </div>
          )
        )}
      </section>

      <section className="session__block session__block--timeline">
        <div className="session__block-head">
          <h3 className="session__block-title">Timeline</h3>
          {events.length > 0 && <span className="muted nums">{events.length} events</span>}
        </div>

        {timeline.state === 'loading' && (
          <div className="session__loading" role="status">
            <Spinner /> Reading the history…
          </div>
        )}

        {timeline.state === 'error' && (
          <div className="banner banner--error" role="alert">
            <Icon name="alert" size={15} className="banner__icon" />
            <span>{timeline.error}</span>
          </div>
        )}

        {timeline.state === 'ready' && events.length === 0 && (
          <p className="muted session__note">Nothing has been recorded in this room yet.</p>
        )}

        {events.length > 0 && (
          <ol className="session__events" ref={listRef}>
            {events.map((event) => {
              const { text, by } = describeEvent(event)
              return (
                <li key={event.id} data-event={event.id}>
                  <button
                    type="button"
                    className={'session__event' + (event.id === activeId ? ' is-current' : '')}
                    onClick={() => onSeek(event.seq)}
                    aria-current={event.id === activeId ? 'step' : undefined}
                  >
                    <span className="session__clock nums">{event.clock}</span>
                    <Icon name={iconForKind(event.kind)} size={13} />
                    <span className="session__what">
                      {text}
                      {(by || event.detail) && (
                        <span className="muted">
                          {by ? ' · ' + by : ''}
                          {event.detail ? ' · ' + event.detail : ''}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}

        {timeline.data?.truncated && (
          <p className="session__note muted">
            This history is longer than one timeline shows; later events are not listed.
          </p>
        )}
      </section>
    </aside>
  )
}

export const SessionPanel = memo(SessionPanelBase)
