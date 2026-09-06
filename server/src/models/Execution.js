import mongoose from 'mongoose'
import { STATES, TERMINATION } from '../services/execution/limits.js'

/**
 * One run of one program.
 *
 * Runs used to leave no trace: the result went to whoever pressed the button
 * and to whoever happened to be in the room at that moment, and then it was
 * gone. That is fine until somebody asks the two questions people actually
 * ask — "what did that print again?" and "who ran the thing that took the
 * server down?" — and there is nothing to answer either with.
 *
 * The row is also what makes cancellation and the room timeline possible: both
 * need a name for a run that outlives the request that started it.
 *
 * Output is stored already capped and already redacted, exactly as the room
 * saw it. This collection must not become the place where the host paths that
 * were carefully kept out of the broadcast are written down instead.
 */
const executionSchema = new mongoose.Schema(
  {
    /** The id the API, the socket events and the client all use. */
    executionId: { type: String, required: true },

    roomId: { type: String, required: true },

    /**
     * Null for a guest, who has no account to point at.
     *
     * `userName` is kept beside it rather than joined on demand: a name is
     * what the console shows, guests only ever have one, and a person who
     * later changes theirs has not changed who ran this.
     */
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    userName: { type: String, default: null, maxlength: 64 },

    language: { type: String, required: true, maxlength: 32 },

    /**
     * Which version of the buffer ran.
     *
     * A hash rather than the source: it answers "was this the same code?"
     * across runs, which is the question worth answering, without this
     * collection becoming a second copy of everything anyone has ever typed
     * into a room.
     */
    sourceHash: { type: String, required: true, maxlength: 64 },
    sourceBytes: { type: Number, default: 0 },

    state: { type: String, required: true, enum: STATES, index: true },
    termination: { type: String, default: null, enum: [...Object.values(TERMINATION), null] },

    /** Which isolation actually ran it, which is not always what is configured. */
    backend: { type: String, default: null, maxlength: 32 },
    stage: { type: String, default: null, enum: ['compile', 'run', null] },

    queuedAt: { type: Date, required: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    /** Time inside the sandbox, not time since the button was pressed. */
    durationMs: { type: Number, default: 0 },

    exitCode: { type: Number, default: null },
    signal: { type: String, default: null, maxlength: 16 },

    stdout: { type: String, default: '' },
    stderr: { type: String, default: '' },
    truncated: { type: Boolean, default: false },

    /**
     * When this row deletes itself.
     *
     * Program output is whatever someone typed into a shared editor, which is
     * to say it is unpredictable and occasionally personal. Keeping it forever
     * is a liability nobody asked for; keeping it for a while is what makes
     * the console survive a page reload.
     */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
)

/** Every lookup by id, and the id is what every API path carries. */
executionSchema.index({ executionId: 1 }, { unique: true })

/** A room's recent runs, newest first — the history the console reloads. */
executionSchema.index({ roomId: 1, createdAt: -1 })

/** Answering "what has this person been running", for abuse triage. */
executionSchema.index({ user: 1, createdAt: -1 })

executionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

/** What a room member is allowed to see, which is everything but the ids. */
executionSchema.methods.toPublic = function toPublic() {
  return {
    executionId: this.executionId,
    roomId: this.roomId,
    by: this.user || this.userName ? { id: this.user?.toString() ?? null, name: this.userName } : null,
    language: this.language,
    sourceHash: this.sourceHash,
    state: this.state,
    termination: this.termination,
    stage: this.stage,
    queuedAt: this.queuedAt,
    startedAt: this.startedAt,
    finishedAt: this.finishedAt,
    durationMs: this.durationMs,
    exitCode: this.exitCode,
    signal: this.signal,
    stdout: this.stdout,
    stderr: this.stderr,
    truncated: this.truncated,
  }
}

export const Execution = mongoose.model('Execution', executionSchema)
