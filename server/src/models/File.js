import mongoose from 'mongoose'

const fileSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, trim: true, index: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    originalName: { type: String, required: true, trim: true, maxlength: 255 },
    storedName: { type: String, required: true, unique: true, trim: true },
    mimeType: { type: String, required: true, trim: true, maxlength: 127 },
    size: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
)

// Queries: list files in a room (most recent first), count by room.
fileSchema.index({ roomId: 1, createdAt: -1 })

// Lookup a specific file within a room by its stored name.
fileSchema.index({ roomId: 1, storedName: 1 }, { unique: true })

/**
 * On-disk path relative to the upload root. Derived from roomId + storedName
 * so it never drifts out of sync with either field.
 */
fileSchema.virtual('storagePath').get(function storagePath() {
  return this.roomId + '/' + this.storedName
})

/**
 * Absolute path on the host filesystem.
 */
fileSchema.virtual('absolutePath').get(function absolutePath() {
  // Resolved at call time by the service layer; this virtual is a convenience
  // for code that already has the upload root in scope.
  return undefined
})

fileSchema.methods.toPublic = function toPublic() {
  return {
    id: String(this._id),
    roomId: this.roomId,
    userId: String(this.userId),
    originalName: this.originalName,
    mimeType: this.mimeType,
    size: this.size,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

/**
 * Returns all files in a room, sorted newest-first.
 */
fileSchema.statics.findByRoom = function findByRoom(roomId, { limit = 50, offset = 0 } = {}) {
  return this.find({ roomId }).sort({ createdAt: -1 }).skip(offset).limit(limit).lean()
}

/**
 * Returns the total number of files in a room.
 */
fileSchema.statics.countByRoom = function countByRoom(roomId) {
  return this.countDocuments({ roomId })
}

export const File = mongoose.model('File', fileSchema)
