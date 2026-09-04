/**
 * What the files panel needs to know about a file before the server sees it.
 *
 * Deliberately its own module rather than part of FilesPanel: these are pure
 * functions, and exporting them from a component file costs fast refresh for
 * the whole component — the same reason `languages.js` sits apart from the
 * Monaco setup.
 *
 * The limits mirror the server's defaults (UPLOAD_MAX_SIZE and
 * UPLOAD_ALLOWED_TYPES). They are a courtesy, not the enforcement: the server
 * refuses these too, and it is the one that decides.
 */

export const MAX_BYTES = 10 * 1024 * 1024
export const ACCEPTS = ['image/*', 'application/pdf', 'text/*']

const UNITS = ['B', 'KB', 'MB', 'GB']

/** Size as a person reads it, not as a byte count. */
export function formatSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return ''

  let size = value
  let unit = 0
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024
    unit += 1
  }

  // One decimal only where it says something: 1.5 MB is useful, 1.5 B is not.
  const rounded = size >= 10 || unit === 0 ? Math.round(size) : Math.round(size * 10) / 10
  return rounded + ' ' + UNITS[unit]
}

/** A hint at what a file is, from the only thing we know about it. */
export function iconFor(mimeType) {
  const type = String(mimeType || '')
  if (type.startsWith('image/')) return 'layers'
  if (type.startsWith('text/')) return 'code'
  return 'inbox'
}

/**
 * Why a file cannot be shared, or null if it can.
 *
 * Checking here saves pushing ten megabytes up the wire to be refused, and
 * turns a generic 400 into a sentence about the file that was actually picked.
 */
export function rejectionFor(file) {
  if (!file) return null

  if (file.size > MAX_BYTES) {
    return (
      file.name + ' is ' + formatSize(file.size) + '. The limit is ' + formatSize(MAX_BYTES) + '.'
    )
  }

  const type = String(file.type || '')
    .split(';')[0]
    .trim()
    .toLowerCase()

  const allowed = ACCEPTS.some((accept) =>
    accept.endsWith('/*') ? type.startsWith(accept.slice(0, -1)) : type === accept
  )

  if (!allowed) {
    return (
      (type ? 'Files of type ' + type : 'That kind of file') +
      ' cannot be shared. Images, PDFs and text files can.'
    )
  }

  return null
}
