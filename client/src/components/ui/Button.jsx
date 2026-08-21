import { Spinner } from './Spinner.jsx'
import { Icon } from './Icon.jsx'

/**
 * The app's button.
 *
 * While `loading`, the label is hidden rather than removed so the button keeps
 * its width — a spinner that shrinks the control shifts everything beside it.
 * The label stays in the accessibility tree either way, so queries by name and
 * screen-reader output are unaffected.
 *
 * Router links keep using `<Link className="btn">`; the `.btn` classes are
 * plain CSS and work on any element.
 */
export function Button({
  variant = 'default',
  size = 'md',
  icon,
  iconAfter,
  loading = false,
  block = false,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}) {
  const classes = [
    'btn',
    variant !== 'default' ? 'btn--' + variant : '',
    size !== 'md' ? 'btn--' + size : '',
    block ? 'btn--block' : '',
    !children ? 'btn--icon' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {icon && (
        <span className="btn__icon">
          <Icon name={icon} size={size === 'sm' ? 13 : 15} />
        </span>
      )}

      {children && <span className={loading ? 'btn__label--hidden' : undefined}>{children}</span>}

      {iconAfter && !loading && (
        <span className="btn__icon">
          <Icon name={iconAfter} size={size === 'sm' ? 13 : 15} />
        </span>
      )}

      {/* Hidden from assistive tech: `aria-busy` already conveys the state, and
          a labelled spinner would append itself to the button's accessible
          name, breaking every query that looks the button up by name. */}
      {loading && (
        <span className="btn__spinner" aria-hidden="true">
          <Spinner />
        </span>
      )}
    </button>
  )
}
