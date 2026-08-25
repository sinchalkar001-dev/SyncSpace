import mongoose from 'mongoose'

const fileSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    originalName: { type: String, required: true, maxlength: 255 },
    storedName: { type: String, required: true, unique: true },
    mimeType: { type: String, required: true, maxlength: 127 },
    size: { type: Number, required: true },
    storagePath: { type: String, required: true },
  },
  { timestamps: true }
)

fileSchema.index({ roomId: 1, createdAt: -1 })

fileSchema.methods.toPublic = function toPublic() {
  return {
    id: String(this._id),
    roomId: this.roomId,
    userId: String(this.userId),
    originalName: this.originalName,
    mimeType: this.mimeType,
    size: this.size,
    createdAt: this.createdAt,
  }
}

export const File = mongoose.model('File', fileSchema)
