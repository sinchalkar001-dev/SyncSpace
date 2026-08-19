import { nanoid } from 'nanoid'

const STORAGE_KEY = 'syncspace:identity'

// Distinct hues that stay readable on the dark canvas.
export const USER_COLORS = [
  '#f97316',
  '#22d3ee',
  '#a78bfa',
  '#4ade80',
  '#f472b6',
  '#facc15',
  '#60a5fa',
  '#fb7185',
]

/** Stable colour per id, so the same person is the same colour everywhere. */
export function colorFor(id) {
  const key = String(id || '')
  let hash = 0
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash << 5) - hash + key.charCodeAt(i)
    hash |= 0
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length]
}

/** Reads the local guest identity, creating one on first run. */
export function loadIdentity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.id && parsed?.name) return parsed
    }
  } catch {
    // Corrupted or unavailable storage falls through to a fresh identity.
  }
  const id = nanoid(10)
  return saveIdentity({ id, name: 'Guest-' + id.slice(0, 4), color: colorFor(id), guest: true })
}

export function saveIdentity(identity) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
  } catch {
    // Storage can be disabled; identity just will not persist across reloads.
  }
  return identity
}

export function renameIdentity(name) {
  const current = loadIdentity()
  return saveIdentity({ ...current, name: name.trim() || current.name })
}

/** The presence identity for a signed-in account. */
export function identityFromUser(user) {
  return { id: user.id, name: user.name, color: colorFor(user.id), guest: false }
}
