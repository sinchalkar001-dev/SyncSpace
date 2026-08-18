import mongoose from 'mongoose'

/**
 * The full binary Yjs state for a room, rewritten on a debounce. Loading a
 * room applies this first, then replays any log entries recorded after it.
 */
const snapshotSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },
    state: { type: Buffer, required: true },
    seq: { type: Number, default: 0 },
    size: { type: Number, default: 0 },
  },
  { timestamps: true }
)

export const Snapshot = mongoose.model('Snapshot', snapshotSchema)
