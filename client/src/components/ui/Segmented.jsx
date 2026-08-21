import { Icon } from './Icon.jsx'

/**
 * A row of mutually exclusive choices.
 *
 * Exposed as a tablist so arrow keys and screen readers behave the way people
 * expect from a segmented control. Used for the room's mobile pane switcher and
 * the dashboard's room filters.
 */
export function Segmented({ options, value, onChange, label, block = false, size }) {
  const index = options.findIndex((option) => option.value === value)

  const onKeyDown = (event) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!delta) return
    event.preventDefault()
    // Wraps at both ends, which is what a roving tablist is expected to do.
    const next = (index + delta + options.length) % options.length
    onChange(options[next].value)
  }

  return (
    <div
      className={'segmented' + (block ? ' segmented--block' : '')}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            className={'segmented__option' + (size === 'sm' ? ' btn--sm' : '')}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
          >
            {option.icon && <Icon name={option.icon} size={14} />}
            {option.label}
            {option.count !== undefined && <span className="muted nums">{option.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
