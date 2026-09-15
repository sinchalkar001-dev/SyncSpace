import fs from 'node:fs/promises'
import path from 'node:path'
import { File } from '../models/File.js'
import { getRoom } from './room.service.js'
import { CAPABILITIES, can } from '../permissions.js'
import { UPLOAD_DIR } from '../config/upload.js'
import { sanitizeFilename, generateStoredName } from '../utils/filename.js'
import { badRequest, forbidden, notFound } from '../errors.js'

/**
 * A room's upload directory, which is always directly inside UPLOAD_DIR.
 *
 * A room id is whatever somebody typed into an address bar, and nothing about
 * a room record stops it holding `..` or a slash. Joined onto a path as it
 * was, `x/../../client/dist` walked an upload out of the directory and into
 * any folder the server could write to, a web root included. Refused rather
 * than rewritten, so every file a room already stored stays where it is.
 */
function roomDir(roomId) {
  const dir = path.resolve(UPLOAD_DIR, String(roomId))
  if (path.dirname(dir) !== UPLOAD_DIR) {
    throw badRequest('Files cannot be stored for this room', 'invalid_room_id')
  }
  return dir
}

/** Where a file document's bytes are on disk. */
const storedPath = (file) => path.join(roomDir(file.roomId), file.storedName)

/**
 * Uploads a file to a room. Validates room access, sanitises the filename,
 * writes to disk, and persists metadata.
 *
 * @param {Object} opts
 * @param {string} opts.roomId
 * @param {string} opts.userId
 * @param {Object} opts.file - multer file object (buffer, originalname, mimetype, size)
 * @returns {Promise<Object>} File metadata (toPublic)
 */
/**
 * Refuses unless the caller holds `capability` in the room.
 *
 * Reading a file needs only access to the room; putting one in it, or taking
 * one out, is a change to shared state and needs the capability for it. The
 * two refusals read differently on purpose — being told you cannot see a room
 * you are plainly looking at is worse than being told what you cannot do.
 */
function requireInRoom(room, userId, capability) {
  if (can(room, userId, capability)) return

  if (!can(room, userId, CAPABILITIES.ROOM_VIEW)) {
    throw forbidden('You do not have access to this room', 'room_forbidden')
  }

  throw forbidden('You do not have permission to change files in this room', 'permission_denied')
}

export async function uploadFile({ roomId, userId, file }) {
  if (!file) {
    throw badRequest('No file provided', 'no_file')
  }

  const room = await getRoom(roomId)
  requireInRoom(room, userId, CAPABILITIES.FILES_UPLOAD)

  const originalName = sanitizeFilename(file.originalname)
  if (!originalName) {
    throw badRequest('Invalid filename', 'invalid_filename')
  }

  const storedName = generateStoredName(originalName)
  const dir = roomDir(roomId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, storedName), file.buffer)

  const doc = await File.create({
    roomId,
    userId,
    originalName,
    storedName,
    mimeType: file.mimetype,
    size: file.size,
  })

  return doc.toPublic()
}

/**
 * Lists files in a room with pagination.
 */
export async function listFiles(roomId, { userId, limit = 50, offset = 0 } = {}) {
  const room = await getRoom(roomId)
  requireInRoom(room, userId, CAPABILITIES.ROOM_VIEW)

  const [files, total] = await Promise.all([
    File.findByRoom(roomId, { limit, offset }),
    File.countByRoom(roomId),
  ])

  return {
    files: files.map((f) => ({
      id: String(f._id),
      roomId: f.roomId,
      userId: String(f.userId),
      originalName: f.originalName,
      mimeType: f.mimeType,
      size: f.size,
      createdAt: f.createdAt,
    })),
    total,
    limit,
    offset,
  }
}

/**
 * Returns metadata for a single file.
 */
export async function getFileInfo(fileId, { userId }) {
  const file = await File.findById(fileId).lean()
  if (!file) {
    throw notFound('File not found', 'file_not_found')
  }

  const room = await getRoom(file.roomId)
  requireInRoom(room, userId, CAPABILITIES.ROOM_VIEW)

  return {
    id: String(file._id),
    roomId: file.roomId,
    userId: String(file.userId),
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
    createdAt: file.createdAt,
  }
}

/**
 * Returns the absolute path and MIME type for streaming a file download.
 */
export async function getFilePath(fileId, { userId }) {
  const file = await File.findById(fileId).lean()
  if (!file) {
    throw notFound('File not found', 'file_not_found')
  }

  const room = await getRoom(file.roomId)
  requireInRoom(room, userId, CAPABILITIES.ROOM_VIEW)

  return {
    absolutePath: storedPath(file),
    mimeType: file.mimeType,
    originalName: file.originalName,
    size: file.size,
  }
}

/**
 * Deletes a file from disk and removes its metadata.
 * Only the uploader or room owner can delete.
 */
export async function deleteFile(fileId, { userId }) {
  const file = await File.findById(fileId)
  if (!file) {
    throw notFound('File not found', 'file_not_found')
  }

  const room = await getRoom(file.roomId)
  requireInRoom(room, userId, CAPABILITIES.FILES_DELETE)

  // Only uploader or room owner can delete
  const isOwner = room.owner && String(room.owner) === userId
  const isUploader = String(file.userId) === userId
  if (!isOwner && !isUploader) {
    throw forbidden('Only the uploader or room owner can delete files', 'forbidden')
  }

  await fs.unlink(storedPath(file)).catch(() => {
    // File may already be gone from disk — proceed with DB cleanup
  })
  await file.deleteOne()

  return { deleted: true }
}
