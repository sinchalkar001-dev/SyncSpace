import mongoose from 'mongoose'

/**
 * What happened in a room, in the order it happened.
 *
 * The dashboard could show when a room was last touched and nothing about what
 * was done to it, because `lastActivityAt` is a single timestamp that every
 * kind of change overwrites. "Active 4m ago" is not an answer to "is there any
 * point opening this" — a room somebody ran a failing test in and a room
 * somebody renamed look identical.
 *
 * These are recorded where the thing actually happens rather than derived
 * afterwards. There was a tempting shortcut here — the Yjs update log already
 * records every edit, so a feed could be reconstructed from it — but that log
 * is optional (`PERSIST_UPDATE_LOG`), holds opaque binary, and says nothing
 * about executions or chat. A feed built on it would be detailed on the two
 * days somebody enabled it and empty otherwise.
 *
 * Deliberately lossy. Rows expire, edits are throttled at the write site, and
 * nothing here is authoritative for anything: losing the whole collection
 * costs the dashboard a panel and costs the rooms nothing.
 */

/** The five things worth telling somebody about, and no more. */
export const ACTIVITY = Object.freeze({
  CODE_EDITED: 'code.edited',
  WHITEBOARD_UPDATED: 'whiteboard.updated',
  EXECUTION_COMPLETED: 'execution.completed',
  COMMENT_ADDED: 'comment.added',
  COLLABORATOR_JOINED: 'collaborator.joined',
})

export const ACTIVITY_KINDS = Object.freeze(Object.values(ACTIVITY))

/** A month. Long enough to cover a holiday, short enough to stay small. */
const RETENTION_DAYS = 30
export const ACTIVITY_TTL_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000

const activitySchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true },

    kind: { type: String, required: true, enum: ACTIVITY_KINDS },

    /**
     * Who did it, denormalised.
     *
     * The name is stored rather than joined for the same reason `Execution`
     * stores it: a guest has no account to join to, and the feed is read far
     * more often than it is written. `actor` is null for a guest, which is
     * also what makes "was this me?" answerable on the client.
     */
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: null, maxlength: 64 },

    /**
     * A few words about this particular event — a language, an exit status, a
     * shape count. Free-form because each kind wants something different, and
     * capped in the service rather than modelled per kind, which would make
     * adding a sixth kind a schema migration.
     */
    detail: { type: String, default: null, maxlength: 120 },

    at: { type: Date, default: Date.now },

    /** Set on insert; the index below is what actually removes the row. */
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + ACTIVITY_TTL_MS),
    },
  },
  { timestamps: false }
)

// The two reads that exist: one room's feed, and the feed across a set of
// rooms somebody belongs to. Both are "newest first, by room".
activitySchema.index({ roomId: 1, at: -1 })
activitySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

activitySchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    roomId: this.roomId,
    kind: this.kind,
    actorId: this.actor ? String(this.actor) : null,
    actorName: this.actorName,
    detail: this.detail,
    at: this.at,
  }
}

export const Activity = mongoose.model('Activity', activitySchema)
