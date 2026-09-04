import mongoose from 'mongoose'

/**
 * The full binary Yjs state at one point in a room's update log.
 *
 * `Snapshot` answers "where is this room now" and there is exactly one per
 * room. These answer "where was this room at seq N", so there are many — they
 * exist so replay does not have to fold the log from the beginning for every
 * position the scrubber lands on.
 *
 * Two rules keep them honest:
 *
 * Every checkpoint is computed by folding the log itself, never by copying a
 * live in-memory document. A document in memory is only equal to the fold of
 * the log if nothing has gone wrong — a failed insert, a second process, a
 * sequence number allocated but never written. Folding the log cannot disagree
 * with the log.
 *
 * `covers` records how many entries were folded into it. The log is
 * append-only at seq order but not strictly in time order: two updates can be
 * assigned sequence numbers and land in either order. If an entry below this
 * checkpoint's seq arrives after it was built, the count no longer matches and
 * readers know to ignore it rather than serve a state that quietly lost an
 * edit.
 */
const checkpointSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true },
    seq: { type: Number, required: true },
    state: { type: Buffer, required: true },
    /** Entries with seq <= this one at the moment it was built. */
    covers: { type: Number, required: true },
    size: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

// Also the index the "newest checkpoint at or before N" lookup rides on.
checkpointSchema.index({ roomId: 1, seq: 1 }, { unique: true })

export const Checkpoint = mongoose.model('Checkpoint', checkpointSchema)
