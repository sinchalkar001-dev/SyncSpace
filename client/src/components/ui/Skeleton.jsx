/**
 * Loading placeholders.
 *
 * A skeleton shaped like the content it replaces keeps the layout from jumping
 * when real data lands, which reads as faster than a spinner even when it is
 * not. The list is marked `aria-hidden` and paired with a live region by the
 * caller — announcing "loading" once beats announcing eight grey boxes.
 */
export function Skeleton({ width, height, variant = 'text', className = '', style }) {
  const classes = ['skeleton', variant ? 'skeleton--' + variant : '', className]
    .filter(Boolean)
    .join(' ')

  return <span className={classes} style={{ width, height, display: 'block', ...style }} />
}

/** Mirrors the real room card's shape, down to the identity stripe. */
export function RoomCardSkeleton({ index = 0 }) {
  return (
    <li className="roomcard roomcard--skeleton" style={{ '--i': index }}>
      <span className="roomcard__stripe" aria-hidden="true" />
      <div className="roomcard__main">
        <Skeleton variant="title" width={`${38 + ((index * 13) % 30)}%`} />
        <div className="roomcard__meta" style={{ gap: 10 }}>
          <Skeleton width={72} height={16} />
          <Skeleton width={54} height={16} />
          <Skeleton width={90} height={16} />
        </div>
      </div>
    </li>
  )
}

/** A whole list of them, for the dashboard's first paint. */
export function RoomListSkeleton({ count = 3 }) {
  return (
    <ul className="roomlist" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <RoomCardSkeleton key={index} index={index} />
      ))}
    </ul>
  )
}

export function StatGridSkeleton({ count = 4 }) {
  return (
    <div className="statgrid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="statcard" key={index}>
          <Skeleton variant="circle" width={34} height={34} />
          <div className="statcard__body" style={{ flex: 1 }}>
            <Skeleton variant="title" width={48} height={22} />
            <Skeleton width="70%" style={{ marginTop: 8 }} />
          </div>
        </div>
      ))}
    </div>
  )
}
