import mongoose from 'mongoose'

/**
 * Everyone who has actually opened a room, as opposed to `Room.members`
 * which only lists people explicitly invited.
 *
 * Keyed by `userKey` so repeat visits update one row instead of appending:
 * `user:<id>` for an account, `guest:<name>` for an anonymous visitor.
 */
const participantSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    userKey: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, required: true, maxlength: 64 },
    guest: { type: Boolean, default: false },
    visits: { type: Number, default: 0 },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
)

participantSchema.index({ roomId: 1, userKey: 1 }, { unique: true })
participantSchema.index({ roomId: 1, lastSeenAt: -1 })

participantSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    userId: this.user ? String(this.user) : null,
    name: this.name,
    guest: this.guest,
    visits: this.visits,
    firstSeenAt: this.firstSeenAt,
    lastSeenAt: this.lastSeenAt,
  }
}

export const Participant = mongoose.model('Participant', participantSchema)
