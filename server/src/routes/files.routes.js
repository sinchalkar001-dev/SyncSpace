import { Router } from 'express'
import fs from 'node:fs'
import { requireAuth } from '../middleware/auth.js'
import { uploadFile, uploadErrorHandler } from '../middleware/upload.js'
import { createRateLimiters } from '../middleware/rateLimit.js'
import {
  uploadFile as doUpload,
  listFiles,
  getFileInfo,
  getFilePath,
  deleteFile,
} from '../services/file.service.js'

export function createFilesRouter() {
  const filesRouter = Router({ mergeParams: true })
  const { uploadLimiter } = createRateLimiters()

  /**
   * POST /rooms/:roomId/files
   * Upload one file to a room.
   */
  filesRouter.post(
    '/',
    requireAuth,
    uploadLimiter,
    uploadFile,
    uploadErrorHandler,
    async (req, res, next) => {
      try {
        const result = await doUpload({
          roomId: req.params.roomId,
          userId: req.user.id,
          file: req.file,
        })
        res.status(201).json({ file: result })
      } catch (err) {
        next(err)
      }
    }
  )

  /**
   * GET /rooms/:roomId/files
   * List files in a room.
   */
  filesRouter.get('/', requireAuth, async (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100)
      const offset = parseInt(req.query.offset, 10) || 0
      const result = await listFiles(req.params.roomId, {
        userId: req.user.id,
        limit,
        offset,
      })
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  /**
   * GET /rooms/:roomId/files/:fileId
   * Get file metadata.
   */
  filesRouter.get('/:fileId', requireAuth, async (req, res, next) => {
    try {
      const file = await getFileInfo(req.params.fileId, { userId: req.user.id })
      res.json({ file })
    } catch (err) {
      next(err)
    }
  })

  /**
   * GET /rooms/:roomId/files/:fileId/download
   * Download file contents.
   */
  filesRouter.get('/:fileId/download', requireAuth, async (req, res, next) => {
    try {
      const { absolutePath, mimeType, originalName, size } = await getFilePath(
        req.params.fileId,
        { userId: req.user.id }
      )

      res.setHeader('Content-Type', mimeType)
      res.setHeader('Content-Length', size)
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(originalName)}"`
      )

      const stream = fs.createReadStream(absolutePath)
      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(404).json({ error: { code: 'not_found', message: 'File not found on disk' } })
        }
      })
      stream.pipe(res)
    } catch (err) {
      next(err)
    }
  })

  /**
   * DELETE /rooms/:roomId/files/:fileId
   * Delete a file.
   */
  filesRouter.delete('/:fileId', requireAuth, async (req, res, next) => {
    try {
      const result = await deleteFile(req.params.fileId, { userId: req.user.id })
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  return filesRouter
}
