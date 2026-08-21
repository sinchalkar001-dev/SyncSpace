import { Icon } from '../ui/Icon.jsx'

const BAR_HEIGHT = 40
const GAP = 10

/**
 * Floating actions for the current selection.
 *
 * Sits above the selection where possible and flips below when the selection
 * is near the top edge, then clamps horizontally, so the bar is never pushed
 * outside the board no matter where the shapes are.
 */
export function SelectionActions({
  box,
  count,
  locked,
  board,
  onDuplicate,
  onCopy,
  onForward,
  onBackward,
  onToggleLock,
  onDelete,
}) {
  if (!box || !board?.width) return null

  const width = 244
  const above = box.y - BAR_HEIGHT - GAP
  const top = above >= GAP ? above : Math.min(box.y + box.height + GAP, board.height - BAR_HEIGHT - GAP)
  const left = Math.max(
    GAP,
    Math.min(box.x + box.width / 2 - width / 2, board.width - width - GAP)
  )

  const actions = [
    { key: 'duplicate', icon: 'copy', label: 'Duplicate', run: onDuplicate, hidden: locked },
    { key: 'copy', icon: 'layers', label: 'Copy', run: onCopy },
    { key: 'forward', icon: 'chevronUp', label: 'Bring forward', run: onForward, hidden: locked },
    { key: 'backward', icon: 'chevronDown', label: 'Send backward', run: onBackward, hidden: locked },
    {
      key: 'lock',
      icon: locked ? 'lock' : 'unlock',
      label: locked ? 'Unlock' : 'Lock',
      run: onToggleLock,
    },
    { key: 'delete', icon: 'trash', label: 'Delete', run: onDelete, danger: true, hidden: locked },
  ]

  return (
    <div
      className="selbar"
      style={{ left: left + 'px', top: top + 'px', width: width + 'px' }}
      role="toolbar"
      aria-label={'Actions for ' + count + ' selected ' + (count === 1 ? 'object' : 'objects')}
    >
      <span className="selbar__count nums">{count}</span>

      {actions
        .filter((action) => !action.hidden)
        .map((action) => (
          <button
            key={action.key}
            type="button"
            className={'selbar__btn' + (action.danger ? ' selbar__btn--danger' : '')}
            onClick={action.run}
            title={action.label}
            aria-label={action.label}
          >
            <Icon name={action.icon} size={15} />
          </button>
        ))}
    </div>
  )
}
