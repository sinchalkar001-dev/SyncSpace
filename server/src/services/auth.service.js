import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { User } from '../models/User.js'
import { env } from '../config/env.js'
import { conflict, unauthorized } from '../errors.js'

const ROUNDS = 10

export const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS)
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash)

export function issueToken(user) {
  return jwt.sign({ sub: user.id ?? String(user._id), name: user.name }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  })
}

/** Returns the decoded payload, or null when the token is absent or invalid. */
export function verifyToken(token) {
  if (!token) return null
  try {
    return jwt.verify(token, env.JWT_SECRET)
  } catch {
    return null
  }
}

export async function register({ email, password, name }) {
  const existing = await User.findOne({ email: email.toLowerCase() })
  if (existing) throw conflict('That email is already registered', 'email_taken')

  const user = await User.create({
    email: email.toLowerCase(),
    name,
    passwordHash: await hashPassword(password),
  })

  return { user: user.toPublic(), token: issueToken(user) }
}

export async function login({ email, password }) {
  const user = await User.findOne({ email: email.toLowerCase() })
  // Compare regardless of whether the user exists so timing does not leak it.
  const hash = user ? user.passwordHash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin'
  const ok = await verifyPassword(password, hash)

  if (!user || !ok) throw unauthorized('Incorrect email or password', 'bad_credentials')

  return { user: user.toPublic(), token: issueToken(user) }
}
