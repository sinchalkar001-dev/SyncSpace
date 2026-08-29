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
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.passwordHash
        delete ret.verificationTokenHash
        return ret
      },
    },
  }
)

userSchema.index({ verificationTokenHash: 1, verificationTokenExpiresAt: -1 })

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    email: this.email,
    name: this.name,
    emailVerified: this.emailVerified,
  }
}

export const User = mongoose.model('User', userSchema)
