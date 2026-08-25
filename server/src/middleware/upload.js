import multer from 'multer'
import { badRequest } from '../errors.js'
import { MAX_FILE_SIZE, MAX_FILES_PER_UPLOAD, isAllowedMimeType, isAllowedExtension } from '../config/upload.js'

/**
 * Builds a multer instance pre-configured with SyncSpace's upload rules.
 *
 * Storage is memory-only at this layer — the service writes to disk after
 * validation. This keeps the middleware stateless and testable.
 */
function buildUpload() {
  const storage = multer.memoryStorage()

  const fileFilter = (_req, file, cb) => {
    const mimeType = file.mimetype || ''
    const ext = file.originalname ? '.' + file.originalname.split('.').pop().toLowerCase() : ''

    if (!isAllowedMimeType(mimeType)) {
      cb(badRequest(`File type "${mimeType}" is not allowed`, 'invalid_file_type'))
      return
    }

    if (!isAllowedExtension(ext, mimeType)) {
      cb(badRequest(`File extension "${ext}" is not allowed`, 'invalid_file_extension'))
      return
    }

    cb(null, true)
  }

  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: MAX_FILES_PER_UPLOAD,
    },
  })
}

const upload = buildUpload()

/**
 * Single-file upload middleware. Attaches `req.file` on success.
 * Field name: "file"
 */
export const uploadFile = upload.single('file')

/**
 * Multi-file upload middleware. Attaches `req.files` (array) on success.
 * Field name: "files"
 */
export const uploadFiles = upload.array('files', MAX_FILES_PER_UPLOAD)

/**
 * Express error handler for multer errors. Maps multer-specific errors
 * to AppError for consistent API responses.
 */
export function uploadErrorHandler(err, _req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      next(badRequest(`File exceeds the ${MAX_FILE_SIZE} byte limit`, 'file_too_large'))
      return
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      next(badRequest(`Too many files (max ${MAX_FILES_PER_UPLOAD})`, 'too_many_files'))
      return
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      next(badRequest('Unexpected field name in upload', 'unexpected_field'))
      return
    }
    next(badRequest(err.message, 'upload_error'))
    return
  }
  next(err)
}
