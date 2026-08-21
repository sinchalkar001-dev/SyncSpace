/**
 * Activity indicator.
 *
 * With a `label` it announces itself as a live status region. Without one it is
 * purely decorative and stays out of the accessibility tree — which is what you
 * want inside a control that already describes its own busy state.
 */
export function Spinner({ label, size = 'md' }) {
  const className = 'spinner' + (size === 'lg' ? ' spinner--lg' : '')

  if (!label) {
    return (
      <span className={className} aria-hidden="true">
        <span className="spinner__ring" />
      </span>
    )
  }

  return (
    <span className={className} role="status" aria-label={label}>
      <span className="spinner__ring" />
    </span>
  )
}

/**
 * Full-area loading state for a route or a panel. The wrapper is the live
 * region and the visible text is its content, so the label is announced once
 * rather than twice.
 */
export function LoadingBlock({ label = 'Loading' }) {
  return (
    <div className="route-loading" role="status">
      <Spinner size="lg" />
      <p className="muted">{label}</p>
    </div>
  )
}
