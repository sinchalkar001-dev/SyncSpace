export function Spinner({ label = 'Loading' }) {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <span className="spinner__ring" />
    </span>
  )
}
