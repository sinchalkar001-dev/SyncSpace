import { useId, useState } from 'react'
import { Icon } from './Icon.jsx'

/**
 * A labelled text input with its hint, error, and counter wired up.
 *
 * Password fields get a reveal toggle: typing a passphrase blind is the single
 * most common cause of a failed sign-in, and hiding it by default is only worth
 * anything if you can check your work.
 */
export function Field({
  label,
  error,
  hint,
  icon,
  type = 'text',
  maxLength,
  value,
  showCount = false,
  children,
  ...input
}) {
  const id = useId()
  const errorId = id + '-error'
  const hintId = id + '-hint'

  const [revealed, setRevealed] = useState(false)
  const isPassword = type === 'password'
  const inputType = isPassword && revealed ? 'text' : type

  const described =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined

  const wrapClass = [
    'field__wrap',
    icon ? 'field__wrap--icon' : '',
    isPassword ? 'field__wrap--action' : '',
    error ? 'field__wrap--invalid' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="field">
      <div className="field__head">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        {showCount && maxLength && (
          <span className="field__counter">
            {String(value ?? '').length}/{maxLength}
          </span>
        )}
      </div>

      <div className={wrapClass}>
        {icon && (
          <span className="field__icon">
            <Icon name={icon} size={15} />
          </span>
        )}

        <input
          id={id}
          className="input"
          type={inputType}
          value={value}
          maxLength={maxLength}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={described}
          {...input}
        />

        {isPassword && (
          <button
            type="button"
            className="field__action"
            onClick={() => setRevealed((current) => !current)}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            aria-pressed={revealed}
          >
            <Icon name={revealed ? 'eyeOff' : 'eye'} size={15} />
          </button>
        )}
      </div>

      {/* Extras such as a strength meter sit between the input and its hint. */}
      {children}

      {hint && !error && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}

      {error && (
        <p className="field__error" id={errorId}>
          <Icon name="alert" size={13} />
          {error}
        </p>
      )}
    </div>
  )
}
