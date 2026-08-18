/** Avatar stack of everyone currently connected to the room. */
export function PresenceBar({ self, peers }) {
  const everyone = [self, ...peers].filter(Boolean)

  return (
    <div className="presence" title={everyone.map((p) => p.user.name).join(', ')}>
      {everyone.slice(0, 6).map((entry, index) => (
        <span
          key={entry.clientId}
          className="presence__dot"
          style={{ background: entry.user.color, zIndex: 10 - index }}
        >
          {entry.user.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {everyone.length > 6 && <span className="presence__more">+{everyone.length - 6}</span>}
      <span className="presence__count">
        {everyone.length} {everyone.length === 1 ? 'person' : 'people'}
      </span>
    </div>
  )
}
