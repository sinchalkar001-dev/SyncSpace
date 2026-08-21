import { memo } from 'react'

const SHOWN = 6

/**
 * Avatar stack of everyone currently connected to the room.
 *
 * Memoised because awareness fires on every cursor move — several times a
 * second per peer — and this only changes when someone joins or leaves.
 */
function PresenceBarBase({ self, peers }) {
  const everyone = [self, ...peers].filter(Boolean)
  const names = everyone.map((entry) => entry.user.name).join(', ')

  return (
    <div className="presence" title={names}>
      {everyone.slice(0, SHOWN).map((entry, index) => (
        <span
          key={entry.clientId}
          className="presence__dot"
          style={{ background: entry.user.color, zIndex: 10 - index }}
        >
          {entry.user.name.slice(0, 1).toUpperCase()}
        </span>
      ))}

      {everyone.length > SHOWN && (
        <span className="presence__more">+{everyone.length - SHOWN}</span>
      )}

      <span className="presence__count">
        {everyone.length} {everyone.length === 1 ? 'person' : 'people'}
      </span>
    </div>
  )
}

/**
 * Awareness rebuilds the peer array on every cursor move, so a plain shallow
 * compare would never match. Compare only what this component actually draws —
 * who is here and what colour they are — and cursor traffic stops causing
 * re-renders entirely.
 */
const roster = (props) =>
  [props.self, ...props.peers]
    .filter(Boolean)
    .map((entry) => entry.clientId + ':' + entry.user.name + ':' + entry.user.color)
    .join('|')

export const PresenceBar = memo(PresenceBarBase, (prev, next) => roster(prev) === roster(next))
