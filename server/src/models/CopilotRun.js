import mongoose from 'mongoose'

/**
 * One question put to the copilot, and what became of the answer.
 *
 * Kept for the same reasons a generation is kept — it is the room's record of
 * what the AI was asked, what it was shown, and what somebody did about it —
 * plus one this feature adds: the copilot reads the room, so a run is also the
 * record of which parts of the room were read on whose behalf. `sources` is
 * that list, stored exactly as the person was shown it, so "which room data
 * was used" has an answer tomorrow and not only while the panel is open.
 *
 * Nothing here is ever rewritten. A run is what was said at a point in the
 * history, so it carries `throughSeq` — the update-log position the room stood
 * at — and later runs are new documents rather than edits to this one. A
 * summary of a session must not silently become a summary of a different
 * session because somebody drew another box.
 */

/** A file the copilot proposed. Identical in spirit to a generation's. */
const proposedFileSchema = new mongoose.Schema(
  {
    path: { type: String, required: true, trim: true, maxlength: 180 },
    action: { type: String, enum: ['create', 'modify', 'delete'], required: true },
    language: { type: String, default: null, maxlength: 40 },
    contents: { type: String, default: '' },
    rationale: { type: String, default: null, maxlength: 400 },
    size: { type: Number, default: 0 },
    status: { type: String, enum: ['proposed', 'applied', 'rejected'], default: 'proposed' },
    appliedFileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },
    appliedAt: { type: Date, default: null },
    error: { type: String, default: null, maxlength: 300 },
  },
  { _id: true }
)

/**
 * A proposed replacement for the shared code buffer.
 *
 * `baseText` is the buffer as the model was shown it, kept whole rather than
 * hashed. It is what makes "never overwrite user data" checkable instead of
 * hopeful: before this is applied, the buffer must still read exactly like
 * this, or the patch is refused and the person is told the code moved while
 * the model was thinking. A hash would do for the check, but the text also
 * lets the review show what the change is actually against.
 */
const patchSchema = new mongoose.Schema(
  {
    contents: { type: String, default: '' },
    rationale: { type: String, default: null, maxlength: 600 },
    baseText: { type: String, default: '' },
    status: {
      type: String,
      /**
       * `stale` is its own outcome, not a failure. It means the answer was
       * fine and the room moved on — worth telling apart from a patch that
       * was looked at and turned down.
       */
      enum: ['proposed', 'applied', 'rejected', 'stale'],
      default: 'proposed',
    },
    appliedAt: { type: Date, default: null },
  },
  { _id: false }
)

/** What was read to answer, exactly as the person was shown it. */
const sourceSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, maxlength: 40 },
    label: { type: String, required: true, maxlength: 80 },
    detail: { type: String, default: null, maxlength: 200 },
    present: { type: Boolean, default: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
)

const copilotRunSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },

    actionId: { type: String, required: true, maxlength: 60 },
    context: { type: String, required: true, maxlength: 20 },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByName: { type: String, default: null, maxlength: 32 },

    status: { type: String, enum: ['succeeded', 'failed'], required: true },

    /**
     * The coordinates the request carried — a line range, a log position, a
     * run id. Never material: the server resolved these against its own copy
     * of the room, and what it read is in `sources`.
     */
    input: { type: mongoose.Schema.Types.Mixed, default: {} },
    sources: { type: [sourceSchema], default: [] },

    /** Where the room's history stood when this was answered. */
    throughSeq: { type: Number, default: 0 },

    answer: { type: String, default: null },

    /**
     * The structured blocks, whichever ones the action produces. Mixed
     * because the shape is the action's business and this schema should not
     * need editing every time one is added — that being the entire point of
     * the block registry.
     */
    result: { type: mongoose.Schema.Types.Mixed, default: {} },

    files: { type: [proposedFileSchema], default: [] },
    patch: { type: patchSchema, default: null },

    /** What the server refused to keep out of the answer, and why. */
    rejected: { type: [String], default: [] },
    /** Statements dropped for citing events that do not exist. */
    discarded: { type: Number, default: 0 },

    model: { type: String, default: null },
    provider: { type: String, default: null },
    /** False when the provider delivered the answer whole. See ai.providers.js. */
    streamed: { type: Boolean, default: true },
    usage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
    },
    durationMs: { type: Number, default: null },
    error: { type: String, default: null, maxlength: 300 },
  },
  { timestamps: true }
)

/** The room's copilot history, newest first. */
copilotRunSchema.index({ roomId: 1, createdAt: -1 })

copilotRunSchema.methods.toSummary = function toSummary() {
  return {
    id: String(this._id),
    roomId: this.roomId,
    actionId: this.actionId,
    context: this.context,
    status: this.status,
    requestedBy: this.requestedBy ? String(this.requestedBy) : null,
    requestedByName: this.requestedByName,
    answer: this.answer,
    sources: this.sources.map((source) => ({
      key: source.key,
      label: source.label,
      detail: source.detail,
      present: source.present,
      meta: source.meta ?? {},
    })),
    counts: {
      files: this.files.length,
      applied: this.files.filter((file) => file.status === 'applied').length,
      patch: this.patch ? this.patch.status : null,
    },
    throughSeq: this.throughSeq,
    error: this.error,
    model: this.model,
    durationMs: this.durationMs,
    createdAt: this.createdAt,
  }
}

/** The whole answer, for the panel. */
copilotRunSchema.methods.toPublic = function toPublic() {
  return {
    ...this.toSummary(),
    input: this.input ?? {},
    result: this.result ?? {},
    rejected: this.rejected,
    discarded: this.discarded,
    streamed: this.streamed,
    provider: this.provider,
    usage: this.usage,
    files: this.files.map((file) => ({
      id: String(file._id),
      path: file.path,
      action: file.action,
      language: file.language,
      contents: file.contents,
      rationale: file.rationale,
      size: file.size,
      status: file.status,
      appliedFileId: file.appliedFileId ? String(file.appliedFileId) : null,
      appliedAt: file.appliedAt,
      error: file.error,
    })),
    patch: this.patch
      ? {
          contents: this.patch.contents,
          rationale: this.patch.rationale,
          baseText: this.patch.baseText,
          status: this.patch.status,
          appliedAt: this.patch.appliedAt,
        }
      : null,
  }
}

export const CopilotRun = mongoose.model('CopilotRun', copilotRunSchema)
