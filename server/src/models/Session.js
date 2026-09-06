import mongoose from 'mongoose'

/**
 * One signed-in device.
 *
 * A JWT cannot be withdrawn, so revoking one means keeping a record on this
 * side and checking it. The previous version of that record was a single
 * `sessionEpoch` on the account: enough to end every session at once, but not
 * to name them, so there was no way to see what was signed in or to sign out
 * one thing. A row per session answers both, and ending them all is now
 * deleting the rows rather than a separate mechanism beside it.
 *
 * The token carries `jti`; this is what it points at. No row, no session —
 * revoking is a delete, and the absence is the refusal.
 */
const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** The `jti` claim of the token this row stands for. */
    jti: { type: String, required: true },

    /**
     * What the browser called itself, kept raw.
     *
     * Turning it into "Chrome on Windows" is presentation, and presentation
     * belongs where it can change without a migration. Capped because the
     * header is attacker-controlled and unbounded.
     */
    userAgent: { type: String, default: null, maxlength: 400 },

    /**
     * Where it signed in from.
     *
     * Personal data, and kept deliberately: "somewhere I do not recognise" is
     * the whole reason a person reads this list. It lives exactly as long as
     * the session does — revoking deletes the row, and expiry does the same
     * through the index below.
     */
    ip: { type: String, default: null, maxlength: 64 },

    lastSeenAt: { type: Date, default: Date.now },

    /** Mirrors the token's own expiry, so a dead row cannot outlive it. */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
)

/**
 * Every authenticated request looks a session up by `jti`, so this is the
 * index that matters. `unique` also makes a repeated id a write error rather
 * than two rows racing for the same token.
 */
sessionSchema.index({ jti: 1 }, { unique: true })

/** The list a person sees is their own, newest first. */
sessionSchema.index({ user: 1, createdAt: -1 })

/**
 * Expired rows delete themselves. Without this the collection would grow
 * forever with sessions whose tokens stopped working weeks ago — and every
 * one of them would still be holding an IP address.
 */
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

/** What the account's own device list is allowed to see. */
sessionSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    userAgent: this.userAgent,
    ip: this.ip,
    lastSeenAt: this.lastSeenAt,
    createdAt: this.createdAt,
    expiresAt: this.expiresAt,
  }
}

export const Session = mongoose.model('Session', sessionSchema)
