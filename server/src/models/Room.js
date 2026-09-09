import mongoose from 'mongoose'
import { ROLES, ROLE_NAMES } from '../permissions.js'

const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ROLE_NAMES, default: ROLES.EDITOR },
  },
  { _id: false }
)

/**
 * Someone the owner removed. Kept as a list rather than a plain member removal
 * so a public room can still keep a person out: without it, "kick" on a room
 * anyone can open would last exactly as long as it takes them to reload.
 */
const blockedSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
)

/**
 * Somebody invited by an address that has no account yet.
 *
 * Membership is by account id, and there is no account to point at until they
 * sign up — so the address is held here and turned into a real membership the
 * moment one exists. Without this an invite could only ever reach people who
 * had already joined SyncSpace, which is the wrong way round: the invitation
 * is how most people would hear of it at all.
 */
const pendingInviteSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    // Ownership is never handed out by invitation; it moves only by transfer.
    role: {
      type: String,
      enum: ROLE_NAMES.filter((role) => role !== ROLES.OWNER),
      default: ROLES.EDITOR,
    },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, default: Date.now },

    /**
     * The invitation itself, hashed.
     *
     * An invitation used to be nothing but a row saying "this address is
     * expected" — no secret, nothing to present, and no way to accept it other
     * than signing up and having it applied silently. That made it impossible
     * to expire one, impossible to use one only once, and impossible to tell
     * an invitation apart from a guess at an address.
     *
     * Only the hash is stored, so the raw token exists in exactly one place:
     * the email. Losing the database does not hand anybody a way into a room.
     */
    tokenHash: { type: String, default: null },
    expiresAt: { type: Date, default: null },
  },
  { _id: false }
)

/**
 * What a room is for.
 *
 * Four values rather than free-form tags, because this exists to answer one
 * question on a dashboard - "which of these forty is the system design one" -
 * and a tag cloud answers it worse than a fixed set. `general` is the default
 * and the honest label for a room nobody has classified, rather than guessing
 * from the name.
 */
export const ROOM_KINDS = Object.freeze(['general', 'coding', 'interview', 'system-design'])

const roomSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true },
    name: { type: String, trim: true, maxlength: 80, default: 'Untitled room' },

    /**
     * A sentence about what this room is, shown on its card.
     *
     * Short on purpose. Anything longer than a line stops being a label and
     * starts being a document, and a room already has somewhere to put a
     * document - the room.
     */
    description: { type: String, trim: true, maxlength: 280, default: '' },

    kind: { type: String, enum: ROOM_KINDS, default: 'general' },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    members: { type: [memberSchema], default: [] },
    blocked: { type: [blockedSchema], default: [] },
    pendingInvites: { type: [pendingInviteSchema], default: [] },

    // Rooms created ad hoc by opening a URL are public. Rooms created through
    // the API belong to their owner and are invite-only.
    isPublic: { type: Boolean, default: true },

    /**
     * What somebody with no account gets in a public room.
     *
     * Editor, because that is what a public room has always granted and
     * quietly demoting every existing guest to read-only would break rooms
     * that work today. It is a field rather than a constant so an owner can
     * express "anyone may watch, nobody may touch" — which was not something
     * the room could say before.
     */
    guestRole: {
      type: String,
      enum: ROLE_NAMES.filter((role) => role !== ROLES.OWNER && role !== ROLES.ADMIN),
      default: ROLES.EDITOR,
    },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
)

roomSchema.index({ owner: 1, lastActivityAt: -1 })
roomSchema.index({ 'members.user': 1, lastActivityAt: -1 })
// Every registration asks "was this address invited anywhere?", so the lookup
// has to be an index rather than a scan of every room.
roomSchema.index({ 'pendingInvites.email': 1 })
// Accepting one is a lookup by the token's hash, across every room.
roomSchema.index({ 'pendingInvites.tokenHash': 1 })

roomSchema.methods.hasMember = function hasMember(userId) {
  if (!userId) return false
  const id = String(userId)
  if (this.owner && String(this.owner) === id) return true
  return this.members.some((member) => String(member.user) === id)
}

/** Case-folded, because an address is the same address however it was typed. */
roomSchema.methods.pendingInviteFor = function pendingInviteFor(email) {
  if (!email) return null
  const address = String(email).trim().toLowerCase()
  return this.pendingInvites.find((invite) => invite.email === address) ?? null
}

roomSchema.methods.isBlocked = function isBlocked(userId) {
  if (!userId) return false
  const id = String(userId)
  return this.blocked.some((entry) => String(entry.user) === id)
}

roomSchema.methods.toPublic = function toPublic() {
  return {
    roomId: this.roomId,
    name: this.name,
    description: this.description || '',
    kind: this.kind || 'general',
    isPublic: this.isPublic,
    owner: this.owner ? String(this.owner) : null,
    memberCount: this.members.length,
    lastActivityAt: this.lastActivityAt,
    // Distinct from lastActivityAt: one is "somebody was in here", the other
    // is "somebody changed what this room is". A card shows both.
    updatedAt: this.updatedAt,
  }
}

export const Room = mongoose.model('Room', roomSchema)
