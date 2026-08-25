import fs from 'node:fs/promises'
import path from 'node:path'
import { File } from '../models/File.js'
import { canAccess, getRoom } from './room.service.js'
import { UPLOAD_DIR } from '../config/upload.js'
import { sanitizeFilename, generateStoredName } from '../utils/filename.js'
import { badRequest, forbidden, notFound } from '../errors.js'

/**
 * Ensures the upload directory exists. Called once per upload operation.
 * No-op if already present.
 */
async function ensureUploadDir(subdir) {
  const dir = path.join(UPLOAD_DIR, subdir)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

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
export async function uploadFile({ roomId, userId, file }) {
  if (!file) {
    throw badRequest('No file provided', 'no_file')
  }

  const room = await getRoom(roomId)
  if (!room) {
    throw notFound('Room not found', 'room_not_found')
  }
  if (!canAccess(room, userId)) {
    throw forbidden('You do not have access to this room', 'room_forbidden')
  }

  const originalName = sanitizeFilename(file.originalname)
  if (!originalName) {
    throw badRequest('Invalid filename', 'invalid_filename')
  }

  const storedName = generateStoredName(originalName)
  const subdir = roomId
  const dir = await ensureUploadDir(subdir)
  const storagePath = path.join(subdir, storedName)
  const absolutePath = path.join(dir, storedName)

  await fs.writeFile(absolutePath, file.buffer)

  const doc = await File.create({
    roomId,
    userId,
    originalName,
    storedName,
    mimeType: file.mimetype,
    size: file.size,
    storagePath,
  })

  return doc.toPublic()
}

/**
 * Lists files in a room with pagination.
 */
export async function listFiles(roomId, { userId, limit = 50, offset = 0 } = {}) {
  const room = await getRoom(roomId)
  if (!room) {
    throw notFound('Room not found', 'room_not_found')
  }
  if (!canAccess(room, userId)) {
    throw forbidden('You do not have access to this room', 'room_forbidden')
  }

  const [files, total] = await Promise.all([
    File.find({ roomId }).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
    File.countDocuments({ roomId }),
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
  if (!canAccess(room, userId)) {
    throw forbidden('You do not have access to this file', 'room_forbidden')
  }

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
  if (!canAccess(room, userId)) {
    throw forbidden('You do not have access to this file', 'room_forbidden')
  }

  return {
    absolutePath: path.join(UPLOAD_DIR, file.storagePath),
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
  if (!canAccess(room, userId)) {
    throw forbidden('You do not have access to this file', 'room_forbidden')
  }

  // Only uploader or room owner can delete
  const isOwner = room.owner && String(room.owner) === userId
  const isUploader = String(file.userId) === userId
  if (!isOwner && !isUploader) {
    throw forbidden('Only the uploader or room owner can delete files', 'forbidden')
  }

  const absolutePath = path.join(UPLOAD_DIR, file.storagePath)
  await fs.unlink(absolutePath).catch(() => {
    // File may already be gone from disk — proceed with DB cleanup
  })
  await file.deleteOne()

  return { deleted: true }
}
