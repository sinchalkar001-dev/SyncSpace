import mongoose from 'mongoose'

/**
 * What one person has decided about one room.
 *
 * Pinning and archiving are opinions, not properties. Two people sharing an
 * interview room will not agree on which of their forty rooms belongs at the
 * top, and a room somebody has finished with is still live work for the person
 * who owns it — so neither can live on the room itself without one collaborator
 * silently rearranging everybody else's dashboard.
 *
 * A separate collection rather than a field on `Room.members`, for two reasons:
 * an ad-hoc room has no membership row for the person looking at it, and this
 * is read as "everything I have an opinion about", which wants an index on the
 * user rather than a scan of every room's member array.
 *
 * A missing row is the default and the common case, so nothing is written
 * until somebody actually pins or archives something.
 */
const roomPreferenceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    roomId: { type: String, required: true },

    /**
     * Timestamps rather than booleans, so pinned rooms can be ordered by when
     * they were pinned. "Most recently pinned first" is the order people
     * expect from a list they built by hand — a boolean would leave the group
     * sorted by something the person never chose.
     */
    pinnedAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true }
)

// One opinion per person per room, and the lookup that reads them all back.
roomPreferenceSchema.index({ user: 1, roomId: 1 }, { unique: true })

roomPreferenceSchema.methods.toPublic = function toPublic() {
  return {
    roomId: this.roomId,
    pinned: Boolean(this.pinnedAt),
    archived: Boolean(this.archivedAt),
    pinnedAt: this.pinnedAt,
    archivedAt: this.archivedAt,
  }
}

export const RoomPreference = mongoose.model('RoomPreference', roomPreferenceSchema)
