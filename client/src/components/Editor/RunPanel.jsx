import { useEffect, useRef } from 'react'
import { Icon } from '../ui/Icon.jsx'
import { Spinner } from '../ui/Spinner.jsx'

const formatMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : Math.round(ms) + ' ms')

/**
 * How a finished run is summarised in one line.
 *
 * Exit code alone is not enough: a program killed on the timeout has no exit
 * code, a compile error never got as far as running, and a program stopped for
 * using too much memory looks exactly like one that crashed. The server sends
 * a reason for precisely this — `termination` is finer than the state, because
 * "resource limit" covers three different things a person would fix three
 * different ways.
 *
 * The old fields are still read as a fallback. A result broadcast by a server
 * that has not been updated yet has no `state`, and rendering nothing at all
 * would be a worse answer than the one we used to give.
 */
function verdict(result) {
  switch (result.termination) {
    case 'memory_limit':
      return { tone: 'danger', icon: 'alert', label: 'Ran out of memory' }
    case 'output_limit':
      return { tone: 'warn', icon: 'alert', label: 'Stopped — printing too much' }
    case 'process_limit':
      return { tone: 'danger', icon: 'alert', label: 'Stopped — too many processes' }
    case 'cancelled':
      return { tone: 'warn', icon: 'close', label: 'Stopped' }
    case 'failed_to_start':
      return { tone: 'danger', icon: 'alert', label: 'Could not start' }
    default:
      break
  }

  if (result.timedOut || result.state === 'timed_out') {
    return { tone: 'warn', icon: 'clock', label: 'Stopped after ' + formatMs(result.durationMs) }
  }
  if (result.stage === 'compile') {
    return { tone: 'danger', icon: 'alert', label: 'Did not compile' }
  }
  if (result.exitCode === 0) {
    return { tone: 'ok', icon: 'check', label: 'Finished in ' + formatMs(result.durationMs) }
  }
  if (result.exitCode === null) {
    return {
      tone: 'danger',
      icon: 'alert',
      label: 'Stopped' + (result.signal ? ' (' + result.signal + ')' : ''),
    }
  }
  return { tone: 'danger', icon: 'alert', label: 'Exited with ' + result.exitCode }
}

/** What the header says while something is still going. */
function progress(live) {
  if (!live) return null
  if (live.state === 'queued') return 'Queued'
  if (live.mine === false && live.by?.name) return live.by.name + ' is running this'
  return 'Running'
}

/**
 * The console under the editor.
 *
 * Output from everyone's runs lands here, not only your own, because the
 * buffer is shared: seeing "Priya ran this" next to output you did not ask
 * for is the difference between collaboration and a haunting.
 */
export function RunPanel({
  status,
  result,
  error,
  hint,
  stale,
  live,
  cancelling,
  isolation,
  onCancel,
  onHintAction,
  onRun,
  onClear,
  onClose,
}) {
  const bodyRef = useRef(null)

  // A long program's tail is the interesting part.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [result, error, status, live])

  const busy = status === 'running' || Boolean(live)
  const state = result && !busy ? verdict(result) : null
  const waiting = progress(live)

  return (
    <section className="runpanel" aria-label="Program output">
      <header className="runpanel__bar">
        <span className="runpanel__title">Output</span>

        {busy && (
          <span className="runpanel__state runpanel__state--busy">
            <Spinner />
            {waiting || 'Running'}
          </span>
        )}

        {/* Only while there is something to stop, and only once the server has
            named it — before that there is no id to cancel. */}
        {live?.executionId && onCancel && (
          <button
            type="button"
            className="runpanel__cancel"
            onClick={onCancel}
            disabled={cancelling}
          >
            {cancelling ? 'Stopping…' : 'Cancel'}
          </button>
        )}

        {state && (
          <span className={'runpanel__state runpanel__state--' + state.tone}>
            <Icon name={state.icon} size={12} />
            {state.label}
          </span>
        )}

        {result?.by && !busy && (
          <span className="runpanel__author">{result.by.name || 'Someone'} ran this</span>
        )}

        {result?.truncated && <span className="runpanel__note">output truncated</span>}

        <span className="pane__spacer" />

        <button
          type="button"
          className="panebtn"
          onClick={onClear}
          title="Clear output"
          aria-label="Clear output"
        >
          <Icon name="trash" size={13} />
        </button>
        <button
          type="button"
          className="panebtn"
          onClick={onClose}
          title="Hide the console"
          aria-label="Hide the console"
        >
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="runpanel__body" ref={bodyRef} role="log" aria-live="polite" tabIndex={0}>
        {/* Above the output, not below it: the explanation is more use than
            the stack trace it is explaining. */}
        {stale && (
          <p className="runstale">
            <Icon name="clock" size={13} />
            <span>This is an older run — the code or input has changed since.</span>
            {onRun && (
              <button type="button" className="runstale__action" onClick={onRun}>
                Run again
              </button>
            )}
          </p>
        )}

        {hint && !busy && (
          <p className="runhint">
            <Icon name="info" size={13} />
            <span>{hint.message}</span>
            {hint.action && onHintAction && (
              <button type="button" className="runhint__action" onClick={onHintAction}>
                {hint.action}
              </button>
            )}
          </p>
        )}

        {error && (
          <p className="runpanel__error">
            <Icon name="alert" size={13} />
            {error}
          </p>
        )}

        {result?.stdout && <pre className="runpanel__out">{result.stdout}</pre>}
        {result?.stderr && <pre className="runpanel__out runpanel__out--err">{result.stderr}</pre>}

        {!error && result && !result.stdout && !result.stderr && !busy && (
          <p className="runpanel__empty">The program printed nothing.</p>
        )}

        {!error && !result && !busy && (
          <p className="runpanel__empty">Press Run to see what your code prints.</p>
        )}

        {/*
          Said where somebody about to run a stranger's code will read it.
          Whether programs are contained depends on how this server was
          deployed, and "go and read the deployment's environment variables"
          is not an answer available to the person in the room.
        */}
        {isolation?.weak && !busy && (
          <p className="runpanel__warning">
            <Icon name="alert" size={13} />
            <span>
              Programs run unsandboxed on this server — they can read its files
              and reach its network. Only run code you trust.
            </span>
          </p>
        )}
      </div>
    </section>
  )
}
