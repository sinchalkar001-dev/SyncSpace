import { Icon } from './Icon.jsx'
import { useCountUp } from '../../hooks/useCountUp.js'

const TONES = {
  accent: { tone: 'var(--accent)', soft: 'var(--accent-soft)' },
  ok: { tone: 'var(--ok)', soft: 'var(--ok-soft)' },
  info: { tone: 'var(--info)', soft: 'var(--info-soft)' },
  warn: { tone: 'var(--warn)', soft: 'var(--warn-soft)' },
}

/**
 * One number on the dashboard overview.
 *
 * The value counts up on change. `suffix` carries anything that is not part of
 * the number itself — a "3 / 5" split, a unit — so the counter animates the
 * figure without mangling the label.
 */
export function StatCard({ icon, label, value, suffix, tone = 'accent' }) {
  const shown = useCountUp(value)
  const palette = TONES[tone] || TONES.accent

  return (
    <div className="statcard" style={{ '--tone': palette.tone, '--tone-soft': palette.soft }}>
      <span className="statcard__icon">
        <Icon name={icon} size={17} />
      </span>
      <div className="statcard__body">
        {/* Announced as one atomic value so it is not read out mid-count. */}
        <p className="statcard__value" aria-live="polite" aria-atomic="true">
          {shown}
          {suffix && <span className="muted"> {suffix}</span>}
        </p>
        <p className="statcard__label">{label}</p>
      </div>
    </div>
  )
}
