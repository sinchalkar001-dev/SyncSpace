import path from 'node:path'
import { nanoid } from './id.js'

/**
 * Strips path components, control characters, and OS-reserved characters
 * from a user-supplied filename. Returns null if the result is empty.
 */
export function sanitizeFilename(raw) {
  if (!raw || typeof raw !== 'string') return null

  // Take only the basename (strip any directory components)
  let name = path.basename(raw)

  // Remove control characters (0x00–0x1F, 0x7F)
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f\x7f]/g, '')

  // Replace characters that are problematic on Windows and in URLs
  name = name.replace(/[<>:"/\\|?*]/g, '_')

  // Collapse multiple underscores/spaces
  name = name.replace(/[_\s]+/g, '_')

  // Trim leading/trailing underscores, dots, and spaces
  name = name.replace(/^[._\s]+|[._\s]+$/g, '')

  // Enforce max length (255 is the common filesystem limit)
  if (name.length > 255) {
    const ext = path.extname(name)
    name = name.slice(0, 255 - ext.length) + ext
  }

  return name || null
}

/**
 * Generates a unique stored name: `<timestamp>-<nanoid>-<sanitised>`.
 * The original extension is preserved. The result is filesystem-safe.
 */
export function generateStoredName(originalName) {
  const ext = path.extname(originalName).toLowerCase()
  const base = path.basename(originalName, ext)
  const safe = base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'file'
  const id = nanoid(12)
  return `${Date.now()}-${id}-${safe}${ext}`
}
