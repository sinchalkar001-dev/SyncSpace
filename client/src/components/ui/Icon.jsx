/**
 * One icon set for the whole app.
 *
 * Paths were previously inlined at each call site — `MORE_PATH` existed
 * verbatim in both the tool rail and the room card, and the rest were scattered
 * one-offs at inconsistent sizes and stroke weights. Keeping them here means an
 * icon looks the same everywhere it appears.
 *
 * All glyphs are drawn on a 24x24 grid. Stroked by default at 1.7 so weight
 * matches the type; `filled: true` marks the solid ones.
 */

const ICONS = {
  // Whiteboard tools — these render into the rail's aria-labelled buttons.
  select: { d: 'M4 3 L18 11 L11.5 12.4 L14.4 18 L12 19.2 L9.2 13.6 L4 17 Z', filled: true },
  pen: {
    d: 'M3 17.2 L14.1 6.1 L16.9 8.9 L5.8 20 L2 21 Z M15.5 4.7 L17.3 2.9 A1.6 1.6 0 0 1 19.6 5.2 L17.9 7 Z',
    filled: true,
  },
  segment: { d: 'M4 20 L20 4' },
  arrow: { d: 'M4 20 L19.2 4.8 M19.2 4.8 L12.6 6.1 M19.2 4.8 L17.9 11.4' },
  rect: { d: 'M3 5 H21 V19 H3 Z' },
  diamond: { d: 'M12 3 L21 12 L12 21 L3 12 Z' },
  ellipse: { d: 'M12 5 A9 7 0 1 1 12 19 A9 7 0 1 1 12 5 Z' },
  text: { d: 'M4 4 H20 V8 H18 V6 H13 V18 H15.5 V20 H8.5 V18 H11 V6 H6 V8 H4 Z', filled: true },
  eraser: { d: 'M8 20 L3 15 A2 2 0 0 1 3 12 L12 3 A2 2 0 0 1 15 3 L21 9 A2 2 0 0 1 21 12 L13 20 Z', filled: true },

  undo: { d: 'M4 9 H14 A5 5 0 0 1 14 19 H9 M4 9 L8 5 M4 9 L8 13' },
  redo: { d: 'M20 9 H10 A5 5 0 0 0 10 19 H15 M20 9 L16 5 M20 9 L16 13' },

  more: {
    d: 'M12 5.5 A1.6 1.6 0 1 1 12 2.3 A1.6 1.6 0 1 1 12 5.5 Z M12 13.6 A1.6 1.6 0 1 1 12 10.4 A1.6 1.6 0 1 1 12 13.6 Z M12 21.7 A1.6 1.6 0 1 1 12 18.5 A1.6 1.6 0 1 1 12 21.7 Z',
    filled: true,
  },

  plus: { d: 'M12 5 V19 M5 12 H19' },
  minus: { d: 'M5 12 H19' },
  chevronDown: { d: 'M5 9 L12 16 L19 9' },
  arrowRight: { d: 'M4 12 H19 M13 6 L19 12 L13 18' },
  check: { d: 'M4 12.5 L9.5 18 L20 6.5' },
  close: { d: 'M6 6 L18 18 M18 6 L6 18' },

  search: { d: 'M11 4 A7 7 0 1 1 11 18 A7 7 0 1 1 11 4 Z M16.2 16.2 L21 21' },
  eye: { d: 'M2 12 C5 6.5 8.5 4.5 12 4.5 C15.5 4.5 19 6.5 22 12 C19 17.5 15.5 19.5 12 19.5 C8.5 19.5 5 17.5 2 12 Z M12 8.8 A3.2 3.2 0 1 1 12 15.2 A3.2 3.2 0 1 1 12 8.8 Z' },
  eyeOff: {
    d: 'M4 12 C6.4 7.9 9.1 5.8 12 5.4 M20 12 C18.6 14.4 17 16.1 15.3 17.1 M9.6 9.6 A3.2 3.2 0 0 0 14.3 14.3 M3 3 L21 21',
  },

  lock: { d: 'M6 10.5 H18 V20 H6 Z M8.6 10.5 V7.6 A3.4 3.4 0 0 1 15.4 7.6 V10.5' },
  globe: {
    d: 'M12 3 A9 9 0 1 1 12 21 A9 9 0 1 1 12 3 Z M3 12 H21 M12 3 C14.5 5.8 15.6 8.9 15.6 12 C15.6 15.1 14.5 18.2 12 21 C9.5 18.2 8.4 15.1 8.4 12 C8.4 8.9 9.5 5.8 12 3 Z',
  },
  users: {
    d: 'M9 11.4 A3.7 3.7 0 1 1 9 4 A3.7 3.7 0 1 1 9 11.4 Z M2.5 20 C2.5 16.4 5.4 14 9 14 C12.6 14 15.5 16.4 15.5 20 M16.4 4.4 A3.7 3.7 0 0 1 16.4 11.2 M18 14.4 C20.2 15.3 21.5 17.4 21.5 20',
  },
  grid: { d: 'M4 4 H10.5 V10.5 H4 Z M13.5 4 H20 V10.5 H13.5 Z M4 13.5 H10.5 V20 H4 Z M13.5 13.5 H20 V20 H13.5 Z' },
  activity: { d: 'M3 12.5 H7 L10 5 L14 19 L17 12.5 H21' },
  clock: { d: 'M12 3.5 A8.5 8.5 0 1 1 12 20.5 A8.5 8.5 0 1 1 12 3.5 Z M12 7.4 V12.4 L15.4 14.4' },
  zap: { d: 'M13.4 2.5 L4.5 13.6 H11 L10.6 21.5 L19.5 10.4 H13 Z' },
  cursor: { d: 'M5 3 L19 11.6 L12.4 12.9 L15.4 18.7 L12.9 20 L10 14.1 L5 17.6 Z' },
  layers: { d: 'M12 3.2 L21 8 L12 12.8 L3 8 Z M3 12.6 L12 17.4 L21 12.6 M3 16.9 L12 21.7 L21 16.9' },
  code: { d: 'M8.6 7.5 L3.5 12 L8.6 16.5 M15.4 7.5 L20.5 12 L15.4 16.5 M13.6 4.2 L10.4 19.8' },
  copy: { d: 'M9 9 H20 V20 H9 Z M15.5 9 V4 H4 V15.5 H9' },
  trash: { d: 'M4.5 6.5 H19.5 M9.5 6.5 V4.4 H14.5 V6.5 M6.6 6.5 L7.6 20 H16.4 L17.4 6.5' },
  key: { d: 'M14.8 3.5 A5.7 5.7 0 1 1 9.6 12.1 L3.5 18.2 V21 H6.4 L7.5 19.6 H9.6 V17.5 H11.7 L13 16.2 A5.7 5.7 0 0 1 14.8 3.5 Z M16.4 7.6 H16.41' },
  logOut: { d: 'M10 4.5 H4.5 V19.5 H10 M15 8 L19.5 12 L15 16 M19.5 12 H8.5' },
  inbox: { d: 'M3.5 13 L6.5 4.5 H17.5 L20.5 13 V19.5 H3.5 Z M3.5 13 H8.5 A3.5 3.5 0 0 0 15.5 13 H20.5' },

  info: { d: 'M12 3.5 A8.5 8.5 0 1 1 12 20.5 A8.5 8.5 0 1 1 12 3.5 Z M12 11 V16.4 M12 7.8 H12.01' },
  alert: { d: 'M12 3.5 A8.5 8.5 0 1 1 12 20.5 A8.5 8.5 0 1 1 12 3.5 Z M12 7.6 V13 M12 16.4 H12.01' },
  checkCircle: { d: 'M12 3.5 A8.5 8.5 0 1 1 12 20.5 A8.5 8.5 0 1 1 12 3.5 Z M8 12.2 L11 15.2 L16.2 9.4' },
}

export function Icon({ name, size = 16, className, title }) {
  const icon = ICONS[name]
  if (!icon) return null

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : 'true'}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <path
        d={icon.d}
        fill={icon.filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={icon.filled ? 0 : 1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const ICON_NAMES = Object.keys(ICONS)
