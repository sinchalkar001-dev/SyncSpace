import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 32 },
  },
  { timestamps: true }
)

userSchema.methods.toPublic = function toPublic() {
  return { id: this._id.toString(), email: this.email, name: this.name }
}

export const User = mongoose.model('User', userSchema)
