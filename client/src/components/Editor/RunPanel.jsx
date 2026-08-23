import { useEffect, useRef } from 'react'
import { Icon } from '../ui/Icon.jsx'
import { Spinner } from '../ui/Spinner.jsx'

const formatMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : Math.round(ms) + ' ms')

/**
 * How a finished run is summarised in one line.
 *
 * Exit code alone is not enough: a program killed on the timeout has no exit
 * code, and a compile error never got as far as running.
 */
function verdict(result) {
  if (result.timedOut) {
    return { tone: 'warn', icon: 'clock', label: 'Stopped after ' + formatMs(result.durationMs) }
  }
  if (result.stage === 'compile') {
    return { tone: 'danger', icon: 'alert', label: 'Did not compile' }
  }
  if (result.exitCode === 0) {
    return { tone: 'ok', icon: 'check', label: 'Finished in ' + formatMs(result.durationMs) }
  }
  if (result.exitCode === null) {
    return { tone: 'danger', icon: 'alert', label: 'Stopped' + (result.signal ? ' (' + result.signal + ')' : '') }
  }
  return { tone: 'danger', icon: 'alert', label: 'Exited with ' + result.exitCode }
}

/**
 * The console under the editor.
 *
 * Output from everyone's runs lands here, not only your own, because the
 * buffer is shared: seeing "Priya ran this" next to output you did not ask
 * for is the difference between collaboration and a haunting.
 */
export function RunPanel({ status, result, error, hint, onHintAction, onClear, onClose }) {
  const bodyRef = useRef(null)

  // A long program's tail is the interesting part.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [result, error, status])

  const state = result && status !== 'running' ? verdict(result) : null

  return (
    <section className="runpanel" aria-label="Program output">
      <header className="runpanel__bar">
        <span className="runpanel__title">Output</span>

        {status === 'running' && (
          <span className="runpanel__state runpanel__state--busy">
            <Spinner />
            Running
          </span>
        )}

        {state && (
          <span className={'runpanel__state runpanel__state--' + state.tone}>
            <Icon name={state.icon} size={12} />
            {state.label}
          </span>
        )}

        {result?.by && (
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
        {hint && status !== 'running' && (
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

        {!error && result && !result.stdout && !result.stderr && status !== 'running' && (
          <p className="runpanel__empty">The program printed nothing.</p>
        )}

        {!error && !result && status !== 'running' && (
          <p className="runpanel__empty">Press Run to see what your code prints.</p>
        )}
      </div>
    </section>
  )
}
