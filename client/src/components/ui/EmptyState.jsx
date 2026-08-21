import { Icon } from './Icon.jsx'

/**
 * The screen you see when there is nothing to see.
 *
 * Every empty state answers the same three questions: what would be here, why
 * it is not, and what to do about it. An error variant swaps the tone without
 * changing the shape, so a failed load and an empty list feel like the same
 * surface rather than two unrelated screens.
 */
export function EmptyState({ icon = 'inbox', title, body, action, variant = 'default' }) {
  return (
    <div
      className={'empty' + (variant === 'error' ? ' empty--error' : '')}
      role={variant === 'error' ? 'alert' : undefined}
    >
      <span className="empty__icon">
        <Icon name={variant === 'error' ? 'alert' : icon} size={22} />
      </span>
      <p className="empty__title">{title}</p>
      {body && <p className="empty__body">{body}</p>}
      {action}
    </div>
  )
}
