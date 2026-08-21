/**
 * A minimal bar chart for the dashboard's activity strip.
 *
 * Deliberately not a charting library: this is seven bars derived from data the
 * page has already fetched, and pulling in a dependency for it would cost more
 * than it returns. Bars are sized as a share of the busiest day, with a floor
 * so a day with activity never renders as nothing.
 */
export function Sparkline({ days, label = 'Activity over the last 7 days' }) {
  const peak = Math.max(1, ...days.map((day) => day.value))

  return (
    <div>
      <div className="spark" role="img" aria-label={summarise(days, label)}>
        {days.map((day) => (
          <div
            key={day.label}
            className={
              'spark__bar' +
              (day.isToday ? ' is-today' : '') +
              (day.value === 0 ? ' spark__bar--empty' : '')
            }
            style={{ height: day.value === 0 ? '3px' : (day.value / peak) * 100 + '%' }}
            title={day.label + ': ' + day.value}
          />
        ))}
      </div>
      <div className="spark__axis" aria-hidden="true">
        <span>{days[0]?.label}</span>
        <span>{days[days.length - 1]?.label}</span>
      </div>
    </div>
  )
}

/** One sentence for assistive tech, rather than seven unlabelled rectangles. */
function summarise(days, label) {
  const total = days.reduce((sum, day) => sum + day.value, 0)
  return label + ': ' + total + ' active across ' + days.length + ' days'
}
