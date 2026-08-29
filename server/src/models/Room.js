import mongoose from 'mongoose'

const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['owner', 'editor', 'viewer'], default: 'editor' },
  },
  { _id: false }
)

const roomSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true },
    name: { type: String, trim: true, maxlength: 80, default: 'Untitled room' },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    members: { type: [memberSchema], default: [] },

    // Rooms created ad hoc by opening a URL are public. Rooms created through
    // the API belong to their owner and are invite-only.
    isPublic: { type: Boolean, default: true },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
)

roomSchema.index({ owner: 1, lastActivityAt: -1 })
roomSchema.index({ 'members.user': 1, lastActivityAt: -1 })

roomSchema.methods.hasMember = function hasMember(userId) {
  if (!userId) return false
  const id = String(userId)
  if (this.owner && String(this.owner) === id) return true
  return this.members.some((member) => String(member.user) === id)
}

roomSchema.methods.toPublic = function toPublic() {
  return {
    roomId: this.roomId,
    name: this.name,
    isPublic: this.isPublic,
    owner: this.owner ? String(this.owner) : null,
    memberCount: this.members.length,
    lastActivityAt: this.lastActivityAt,
  }
}

export const Room = mongoose.model('Room', roomSchema)
