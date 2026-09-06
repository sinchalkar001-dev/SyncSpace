import mongoose from 'mongoose'

/**
 * One run of "generate from whiteboard", and what became of it.
 *
 * Kept rather than streamed and forgotten, for three reasons. It is the room's
 * record of what the AI was asked and what it said, which is the difference
 * between a feature and a party trick. It is where the review state lives, so
 * a change set can be looked at now and applied tomorrow, by somebody else,
 * from another machine. And it is the audit trail: every file this feature
 * ever wrote into a room can be traced back to the diagram and the person who
 * accepted it.
 */

/**
 * One proposed file.
 *
 * `action` is decided by the server, not taken from the model — see
 * generation.service.js. A file that already exists in the room is a modify
 * however confidently the answer called it a create, which is what keeps this
 * from quietly overwriting somebody's work.
 */
const proposedFileSchema = new mongoose.Schema(
  {
    path: { type: String, required: true, trim: true, maxlength: 180 },
    action: { type: String, enum: ['create', 'modify', 'delete'], required: true },
    language: { type: String, default: null, maxlength: 40 },

    /** The whole file. Empty for a delete, which proposes removal, not content. */
    contents: { type: String, default: '' },
    rationale: { type: String, default: null, maxlength: 400 },
    size: { type: Number, default: 0 },

    /**
     * Where this file stands.
     *
     * `proposed` until somebody decides. `applied` means it was written into
     * the room's files; `rejected` means it was looked at and turned down.
     * Rejected is kept rather than deleted so the record says what was
     * considered, not only what was taken.
     */
    status: {
      type: String,
      enum: ['proposed', 'applied', 'rejected'],
      default: 'proposed',
    },

    /** The room file this became, once applied. */
    appliedFileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },
    appliedAt: { type: Date, default: null },

    /** Why applying this one failed, when it did. */
    error: { type: String, default: null, maxlength: 300 },
  },
  { _id: true }
)

const generationSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Denormalised so the timeline reads correctly for an account that has
    // since left, exactly as the whiteboard keeps authorName on a shape.
    requestedByName: { type: String, default: null, maxlength: 32 },

    status: {
      type: String,
      enum: ['succeeded', 'failed'],
      required: true,
    },

    targets: { type: [String], default: [] },
    intent: { type: String, default: null, maxlength: 2000 },

    /**
     * The graph as it was read at the moment of asking.
     *
     * Stored whole because the whiteboard keeps moving. Without this, opening
     * a change set a day later would show it beside a diagram that has since
     * changed, with no way to tell which parts it was actually answering.
     */
    architecture: {
      nodes: { type: Array, default: [] },
      edges: { type: Array, default: [] },
      notes: { type: Array, default: [] },
      warnings: { type: Array, default: [] },
    },

    summary: { type: String, default: null },
    plan: { type: Array, default: [] },
    assumptions: { type: [String], default: [] },
    questions: { type: [String], default: [] },

    /** What the server refused to keep out of the model's answer, and why. */
    rejected: { type: [String], default: [] },

    files: { type: [proposedFileSchema], default: [] },

    model: { type: String, default: null },
    usage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
    },
    durationMs: { type: Number, default: null },
    error: { type: String, default: null, maxlength: 300 },
  },
  { timestamps: true }
)

/** The room's AI timeline: newest first. */
generationSchema.index({ roomId: 1, createdAt: -1 })

/** The list view — everything except the file contents, which dominate the size. */
generationSchema.methods.toSummary = function toSummary() {
  const counts = this.files.reduce(
    (tally, file) => ({ ...tally, [file.action]: (tally[file.action] ?? 0) + 1 }),
    {}
  )

  return {
    id: String(this._id),
    roomId: this.roomId,
    status: this.status,
    requestedBy: this.requestedBy ? String(this.requestedBy) : null,
    requestedByName: this.requestedByName,
    targets: this.targets,
    summary: this.summary,
    counts: {
      create: counts.create ?? 0,
      modify: counts.modify ?? 0,
      delete: counts.delete ?? 0,
      applied: this.files.filter((file) => file.status === 'applied').length,
      rejected: this.files.filter((file) => file.status === 'rejected').length,
      total: this.files.length,
    },
    nodes: this.architecture?.nodes?.length ?? 0,
    edges: this.architecture?.edges?.length ?? 0,
    questions: this.questions.length,
    error: this.error,
    model: this.model,
    durationMs: this.durationMs,
    createdAt: this.createdAt,
  }
}

/** The full change set, for the review screen. */
generationSchema.methods.toPublic = function toPublic() {
  return {
    ...this.toSummary(),
    intent: this.intent,
    architecture: this.architecture,
    plan: this.plan,
    assumptions: this.assumptions,
    questions: this.questions,
    rejected: this.rejected,
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
  }
}

export const Generation = mongoose.model('Generation', generationSchema)
