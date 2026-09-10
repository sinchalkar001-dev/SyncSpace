import mongoose from 'mongoose'

/**
 * What a model said about a room's history, kept so it is only said once.
 *
 * A summary is expensive — a model call that holds a request open for seconds
 * and costs somebody's API budget — and the history it describes does not
 * change unless the room does. So each answer is stored against a signature of
 * everything it was built from: the last position in the update log, and how
 * many runs, activity rows and AI proposals existed at the time. Asking again
 * with the same signature is a database read, not a model call; asking after
 * the room has moved on produces a fresh answer and the old one reads as stale.
 *
 * `result` is stored exactly as it was returned to the client — already
 * grounded, with every statement pointing at events that exist — so a cached
 * answer can never be less checked than a fresh one.
 */

/** A month, the same as the activity feed these summaries are partly built on. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const sessionInsightSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true },

    /** A summary of the whole session, or an explanation of one point in it. */
    kind: { type: String, required: true, enum: ['session', 'moment'] },

    /** What the answer was built from; equal signatures mean equal inputs. */
    signature: { type: String, required: true, maxlength: 200 },
    throughSeq: { type: Number, default: 0 },

    /** For a moment: the log position it explains. */
    atSeq: { type: Number, default: null },

    result: { type: mongoose.Schema.Types.Mixed, required: true },

    /**
     * Statements the model made that cited no real event and were dropped.
     * Kept rather than hidden: a summary that had to lose half its claims is
     * worth knowing about, and the count is how anybody would find out.
     */
    discarded: { type: Number, default: 0 },

    model: { type: String, default: null },
    provider: { type: String, default: null },
    usage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: null, maxlength: 64 },

    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + RETENTION_MS),
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

// The cache lookup, and "the latest summary of this room".
sessionInsightSchema.index({ roomId: 1, kind: 1, signature: 1, atSeq: 1 })
sessionInsightSchema.index({ roomId: 1, kind: 1, createdAt: -1 })
sessionInsightSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

sessionInsightSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    kind: this.kind,
    signature: this.signature,
    throughSeq: this.throughSeq,
    atSeq: this.atSeq,
    ...this.result,
    discarded: this.discarded,
    model: this.model,
    createdByName: this.createdByName,
    createdAt: this.createdAt,
  }
}

export const SessionInsight = mongoose.model('SessionInsight', sessionInsightSchema)
