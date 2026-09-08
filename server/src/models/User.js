import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 32 },

    // Email verification. Only a SHA-256 hash of the token is stored, so a
    // database leak cannot be replayed against the confirm endpoint (the same
    // reasoning as passwordHash above).
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },
    verificationTokenHash: { type: String, default: null },
    verificationTokenExpiresAt: { type: Date, default: null },

    /**
     * The six-digit code, hashed like everything else here.
     *
     * A second way to prove the same address, for the person reading the email
     * on a phone and typing into a laptop. It has its own expiry because it is
     * a different risk: the token is 256 bits nobody can guess, the code is a
     * million combinations somebody can script — so it lives a shorter life
     * and carries an attempt count the token does not need.
     */
    verificationCodeHash: { type: String, default: null },
    verificationCodeExpiresAt: { type: Date, default: null },

    /**
     * Wrong codes since the last one was issued.
     *
     * Reset when a fresh code is sent, because the budget belongs to the code
     * rather than to the account — otherwise a person who mistyped twice last
     * week would find themselves locked out of a code they have only just
     * received.
     */
    verificationAttempts: { type: Number, default: 0 },

    /**
     * When the last verification email went out, for the resend cooldown.
     *
     * Held on the account rather than in memory so the cooldown survives a
     * restart and holds across every process — an in-memory timer makes
     * "resend" a way to mail-bomb an address from a second server.
     */
    lastVerificationSentAt: { type: Date, default: null },

    // Password reset. Stored the same way and for the same reason, but with a
    // much shorter life: a confirmation link proves an address, while this one
    // hands over the account, so it is worth far less time to an attacker who
    // gets at a mailbox later.
    resetTokenHash: { type: String, default: null },
    resetTokenExpiresAt: { type: Date, default: null },

    // Sessions are not held here. A JWT can only be revoked against something
    // on this side, and that something is a row per signed-in device in the
    // Session collection — see models/Session.js. Keeping a counter here
    // instead would revoke all of them or none, which is what it used to do.
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.passwordHash
        delete ret.verificationTokenHash
        delete ret.verificationCodeHash
        delete ret.resetTokenHash
        return ret
      },
    },
  }
)

userSchema.index({ verificationTokenHash: 1, verificationTokenExpiresAt: -1 })
// The code is looked up by account, not by value — six digits are not unique
// across users, and a lookup by code alone would let one person's guess land
// on somebody else's account.
userSchema.index({ resetTokenHash: 1, resetTokenExpiresAt: -1 })

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    email: this.email,
    name: this.name,
    emailVerified: this.emailVerified,
  }
}

export const User = mongoose.model('User', userSchema)
