import path from 'node:path'
import { env } from './env.js'

export const UPLOAD_DIR = path.resolve(env.UPLOAD_DIR)
export const MAX_FILE_SIZE = env.UPLOAD_MAX_SIZE
export const MAX_FILES_PER_UPLOAD = 5

/**
 * MIME type prefixes that are allowed. Each entry is checked with
 * `mimeType.startsWith(prefix)`, so "image/" matches image/png, image/jpeg, etc.
 */
export const ALLOWED_MIME_PREFIXES = env.UPLOAD_ALLOWED_TYPES

/**
 * Explicit extension→MIME mapping for cross-validation. When a file arrives
 * we check both the declared Content-Type and the file extension against
 * this list to prevent extension/MIME mismatches (e.g. a .exe renamed to .png).
 */
export const EXTENSION_MAP = {
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',

  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  // Text
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.md': 'text/markdown',

  // Data
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
}

/**
 * Returns true if the MIME type matches any of the allowed prefixes.
 * Supports glob-style wildcards: "image/*" matches "image/png", "image/jpeg", etc.
 */
export function isAllowedMimeType(mimeType) {
  if (!mimeType) return false
  const normalised = mimeType.split(';')[0].trim().toLowerCase()
  return ALLOWED_MIME_PREFIXES.some((prefix) => {
    const clean = prefix.endsWith('/*') ? prefix.slice(0, -1) : prefix
    return normalised.startsWith(clean)
  })
}

/**
 * Returns true if the extension is compatible with the declared Content-Type.
 * When the extension is not in the allowlist we cannot cross-validate, but
 * the MIME check has already passed — so we return true (permissive).
 * We only reject when the extension IS in the map but mismatches the MIME.
 */
export function isAllowedExtension(extension, mimeType) {
  if (!extension) return true
  const ext = extension.toLowerCase()
  const expectedMime = EXTENSION_MAP[ext]
  if (!expectedMime) return true

  // Extension's expected MIME must be compatible with the declared type.
  const normalised = (mimeType || '').split(';')[0].trim().toLowerCase()
  return normalised.startsWith(expectedMime.split('/')[0])
}
