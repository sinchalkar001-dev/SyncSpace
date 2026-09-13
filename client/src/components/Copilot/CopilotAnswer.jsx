import { Icon } from '../ui/Icon.jsx'
import { bySeverity, describeSource, SEVERITY_LABELS, SIZE_LABELS } from '../../lib/copilot.js'

/**
 * One answer: what it read, what it said, and what it found.
 *
 * The order is deliberate and is the main thing separating this from a chat
 * bubble. The sources come first, before a word of the answer, because
 * "architecture — 7 components, 6 connections" tells a reader what the answer
 * can possibly be about, and finding that out afterwards is finding it out too
 * late. Then the prose. Then the structured parts, which are the bits somebody
 * will actually act on.
 *
 * Every block renders generically from `result`, keyed by the block name the
 * action produced. Adding an action to the registry adds nothing here; adding
 * a *block* adds one case. That is the difference between twenty-five buttons
 * and twenty-five features.
 */

/**
 * What the copilot read, shown while it is reading it.
 *
 * A source that found nothing keeps its chip. Dropping it would leave a reader
 * assuming the answer was based on it, which is the one misreading that costs
 * something — "it reviewed my architecture" when the board was empty.
 */
function Sources({ sources }) {
  if (!sources?.length) return null

  return (
    <div className="copilot__sources">
      <h6 className="copilot__blocktitle">Read from this room</h6>
      <ul className="copilot__chips">
        {sources.map((source) => (
          <li
            key={source.key}
            className={'copilot__chip' + (source.present ? '' : ' is-empty')}
            title={describeSource(source)}
          >
            <Icon name={source.present ? 'check' : 'minus'} size={11} />
            <span className="copilot__chiplabel">{source.label}</span>
            <span className="copilot__chipdetail">{source.present ? source.detail : 'empty'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Findings({ items }) {
  return (
    <ul className="copilot__findings">
      {bySeverity(items).map((finding, index) => (
        <li key={index} className={'copilot__finding is-' + finding.severity}>
          <div className="copilot__findinghead">
            <span className={'copilot__severity is-' + finding.severity}>
              {SEVERITY_LABELS[finding.severity] ?? finding.severity}
            </span>
            <strong>{finding.title}</strong>
          </div>
          {finding.detail && <p className="copilot__findingdetail">{finding.detail}</p>}
          {finding.evidence?.length > 0 && (
            <p className="copilot__evidence muted">
              <Icon name="search" size={11} /> {finding.evidence.join(' · ')}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

function Steps({ items }) {
  return (
    <ol className="copilot__steps">
      {items.map((step, index) => (
        <li key={index}>
          <strong>{step.step}</strong>
          {step.detail && <span className="muted"> — {step.detail}</span>}
        </li>
      ))}
    </ol>
  )
}

function Tasks({ items }) {
  return (
    <ul className="copilot__tasks">
      {items.map((task, index) => (
        <li key={index} className="copilot__task">
          <div className="copilot__taskhead">
            <span className={'copilot__size is-' + task.size}>
              {SIZE_LABELS[task.size] ?? task.size}
            </span>
            <strong>{task.title}</strong>
          </div>
          {task.detail && <p className="copilot__findingdetail">{task.detail}</p>}
          {task.blockedBy && (
            <p className="copilot__evidence muted">
              <Icon name="lock" size={11} /> Blocked by {task.blockedBy}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * Rows rather than prose, which is the point of a comparison: "the second run
 * was faster" is an assertion, two numbers side by side are evidence.
 */
function Comparison({ items }) {
  return (
    <div className="copilot__tablewrap">
      <table className="copilot__table">
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row, index) => (
            <tr key={index}>
              <th scope="row">
                {row.subject}
                {row.note && <span className="muted copilot__note"> {row.note}</span>}
              </th>
              <td>
                <code>{row.before || '—'}</code>
              </td>
              <td>
                <code>{row.after || '—'}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The events an answer rests on.
 *
 * Shown with their text rather than as bare ids, because a citation nobody can
 * read is not evidence. Each one was checked against the room's own timeline
 * before it got here — an id naming an event that never happened is dropped on
 * the server and counted, and the count appears below.
 */
function Citations({ ids, cited, onGoTo }) {
  return (
    <ul className="copilot__citations">
      {ids.map((id) => {
        const event = cited?.[id]
        if (!event) return null

        return (
          <li key={id}>
            <button
              type="button"
              className="copilot__citation"
              onClick={() => onGoTo?.(event.seq)}
              disabled={!onGoTo}
            >
              <span className="copilot__clock">{event.clock}</span>
              <span>
                {event.actor ? event.actor + ': ' : ''}
                {event.text}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

const Lines = ({ items }) => (
  <ul className="copilot__list">
    {items.map((line, index) => (
      <li key={index}>{line}</li>
    ))}
  </ul>
)

const BLOCK_TITLES = {
  findings: 'What it found',
  steps: 'In order',
  tasks: 'Work this implies',
  comparison: 'Side by side',
  questions: 'What it would need to be sure',
  assumptions: 'What it assumed',
  citations: 'Where this comes from',
}

export function CopilotAnswer({ action, state, run, onGoToMoment }) {
  const result = run?.result ?? {}
  const streaming = state.state === 'streaming'

  // While streaming, `state.text` is the answer so far. Once the result lands,
  // the recorded answer is authoritative — it is what was stored, and what
  // anybody opening this run tomorrow will read.
  const prose = run?.answer ?? state.text

  return (
    <div className="copilot__answer">
      <Sources sources={run?.sources ?? state.sources} />

      {prose ? (
        <div className={'copilot__prose' + (streaming ? ' is-streaming' : '')}>
          {prose.split(/\n{2,}/).map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      ) : (
        streaming && (
          <p className="copilot__thinking muted" role="status">
            <span className="copilot__dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Reading the room…
          </p>
        )
      )}

      {/* Nothing structured is shown until the answer has finished: half a
          findings list would read as a complete one that is missing things. */}
      {run && (
        <>
          {result.findings?.length > 0 && (
            <section className="copilot__block">
              <h6 className="copilot__blocktitle">{BLOCK_TITLES.findings}</h6>
              <Findings items={result.findings} />
            </section>
          )}

          {result.steps?.length > 0 && (
            <section className="copilot__block">
              <h6 className="copilot__blocktitle">{BLOCK_TITLES.steps}</h6>
              <Steps items={result.steps} />
            </section>
          )}

          {result.tasks?.length > 0 && (
            <section className="copilot__block">
              <h6 className="copilot__blocktitle">{BLOCK_TITLES.tasks}</h6>
              <Tasks items={result.tasks} />
            </section>
          )}

          {result.comparison?.length > 0 && (
            <section className="copilot__block">
              <h6 className="copilot__blocktitle">{BLOCK_TITLES.comparison}</h6>
              <Comparison items={result.comparison} />
            </section>
          )}

          {result.questions?.length > 0 && (
            <section className="copilot__block copilot__block--ask">
              <h6 className="copilot__blocktitle">
                <Icon name="alert" size={12} /> {BLOCK_TITLES.questions}
              </h6>
              <Lines items={result.questions} />
            </section>
          )}

          {/*
            Given the same weight as everything else. An answer that quietly
            assumed PostgreSQL is only safe to act on if the assumption is in
            front of the person acting on it.
          */}
          {result.assumptions?.length > 0 && (
            <section className="copilot__block">
              <h6 className="copilot__blocktitle">
                <Icon name="info" size={12} /> {BLOCK_TITLES.assumptions}
              </h6>
              <Lines items={result.assumptions} />
            </section>
          )}

          {result.citations?.length > 0 && (
            <section className="copilot__block">
              <h6 className="copilot__blocktitle">{BLOCK_TITLES.citations}</h6>
              <Citations ids={result.citations} cited={result.cited} onGoTo={onGoToMoment} />
            </section>
          )}

          {run.discarded > 0 && (
            <p className="copilot__discarded muted">
              {run.discarded} {run.discarded === 1 ? 'citation was' : 'citations were'} dropped for
              naming events that are not in this room’s history.
            </p>
          )}

          {run.rejected?.length > 0 && (
            <section className="copilot__block">
              <h6 className="copilot__blocktitle">What this server changed or refused</h6>
              <Lines items={run.rejected} />
            </section>
          )}

          <p className="copilot__provenance muted">
            {action?.title ?? run.actionId}
            {run.model ? ' · ' + run.model : ''}
            {run.durationMs ? ' · ' + (run.durationMs / 1000).toFixed(1) + 's' : ''}
            {run.streamed === false ? ' · delivered whole' : ''}
          </p>
        </>
      )}
    </div>
  )
}
