import { Component } from 'react'

/**
 * Stops a render-time crash in one pane from blanking the whole app.
 * Errors are surfaced to the user rather than swallowed.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Replace with a real reporter (Sentry et al.) before shipping.
    console.error('[SyncSpace] render error', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="crash" role="alert">
        <h1 className="crash__title">Something broke on this screen</h1>
        <p className="crash__body">
          The error was logged. Reloading usually clears it — your work is stored on the server, not
          in this tab.
        </p>
        <pre className="crash__detail">{String(this.state.error?.message || this.state.error)}</pre>
        <div className="crash__actions">
          <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    )
  }
}
