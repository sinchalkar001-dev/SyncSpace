import mongoose from 'mongoose'

/**
 * Append-only log of every Yjs update, ordered by `seq` within a room.
 * This is what makes the replay scrubber possible, so mutation is blocked
 * at the schema level rather than left to convention.
 */
const docUpdateSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true },
    seq: { type: Number, required: true },
    update: { type: Buffer, required: true },
    actor: { type: String, default: null },
    size: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

docUpdateSchema.index({ roomId: 1, seq: 1 }, { unique: true })

const MUTATIONS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
]

class AppendOnlyViolation extends Error {
  constructor(operation) {
    super('DocUpdate is append-only; ' + operation + ' is not permitted')
    this.name = 'AppendOnlyViolation'
    this.status = 409
  }
}

MUTATIONS.forEach((operation) => {
  docUpdateSchema.pre(operation, function block() {
    throw new AppendOnlyViolation(operation)
  })
})

docUpdateSchema.pre('save', function blockRewrite(next) {
  if (!this.isNew) {
    next(new AppendOnlyViolation('save on an existing document'))
    return
  }
  next()
})

export { AppendOnlyViolation }
export const DocUpdate = mongoose.model('DocUpdate', docUpdateSchema)
