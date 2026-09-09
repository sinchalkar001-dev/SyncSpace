import { forwardRef } from 'react'
import { SORTS } from '../lib/rooms.js'
import { Segmented } from './ui/Segmented.jsx'
import { Icon } from './ui/Icon.jsx'

/**
 * Narrowing a wall of rooms down to the one you want.
 *
 * Four controls, each answering exactly one question — what is it called, what
 * is it for, what order, and do I want the ones I have filed away. They were
 * deliberately not folded into a single "filter" menu: every one of these is
 * worth seeing the current value of without opening anything, and a menu hides
 * precisely that.
 *
 * All of it runs against rooms already in memory, so a keystroke costs a
 * re-render and never a request.
 */
export const RoomFilters = forwardRef(function RoomFilters(
  { query, onQuery, kind, onKind, kinds, sort, onSort, archived, onArchived, archivedCount },
  searchRef
) {
  return (
    <div className="roomtools" role="search">
      <div className="roomtools__search">
        <Icon name="search" size={15} />
        <input
          className="input"
          type="search"
          ref={searchRef}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search rooms, codes, people"
          aria-label="Search rooms"
        />
        {/* Announced rather than drawn: the count beside the heading already
            shows the result, and a second visible copy of it here would move
            under the cursor on every keystroke. */}
        <kbd className="roomtools__key" aria-hidden="true">
          /
        </kbd>
      </div>

      <Segmented options={kinds} value={kind} onChange={onKind} label="Filter by room type" />

      <label className="roomtools__sort">
        <span className="sr-only">Sort rooms</span>
        <Icon name="sort" size={14} aria-hidden="true" />
        <select value={sort} onChange={(event) => onSort(event.target.value)}>
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {/* Hidden entirely when nothing is archived: a toggle that can only ever
          reveal an empty list is a control that teaches you nothing. */}
      {(archivedCount > 0 || archived) && (
        <button
          type="button"
          className={'roomtools__archived' + (archived ? ' roomtools__archived--on' : '')}
          onClick={() => onArchived(!archived)}
          aria-pressed={archived}
        >
          <Icon name="archive" size={14} />
          {archived ? 'Showing archived' : 'Archived'}
          <span className="muted nums">{archivedCount}</span>
        </button>
      )}
    </div>
  )
})
