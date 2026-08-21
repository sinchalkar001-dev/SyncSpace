const TIERS = [
  { label: 'Weak', tone: 'var(--danger)' },
  { label: 'Fair', tone: 'var(--warn)' },
  { label: 'Good', tone: 'var(--accent)' },
  { label: 'Strong', tone: 'var(--ok)' },
]

/**
 * Rough passphrase feedback — length first, variety second.
 *
 * Length is weighted hardest because it is what actually resists a guess; the
 * character-class checks only nudge. This is guidance for the person typing,
 * not a gate: the server's rule is the eight-character minimum enforced in
 * lib/validation.js, and nothing here blocks a submit.
 */
function scorePassword(password) {
  if (!password) return -1

  let score = 0
  if (password.length >= 8) score += 1
  if (password.length >= 12) score += 1
  if (password.length >= 16) score += 1
  if (/[^A-Za-z0-9]/.test(password) || (/[A-Z]/.test(password) && /[0-9]/.test(password))) {
    score += 1
  }

  return Math.min(score, TIERS.length) - 1
}

export function PasswordStrength({ password }) {
  const score = scorePassword(password)
  if (score < 0) return null

  const tier = TIERS[score] || TIERS[0]

  return (
    <div className="strength" style={{ '--tone': tier.tone }}>
      <span className="strength__track">
        {TIERS.map((_, index) => (
          <span key={index} className={'strength__seg' + (index <= score ? ' is-on' : '')} />
        ))}
      </span>
      <span className="strength__label">{tier.label}</span>
    </div>
  )
}
