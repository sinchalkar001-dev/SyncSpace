export const MIN_PASSWORD = 8

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Mirrors the server's zod schema so mistakes surface before a round trip.
 * The server still validates; this only saves the user a wasted request.
 */
export function validateRegistration({ name, email, password }) {
  const errors = {}

  if (!name.trim()) errors.name = 'Pick a display name'
  else if (name.trim().length > 32) errors.name = 'Keep it under 32 characters'

  if (!email.trim()) errors.email = 'Email is required'
  else if (!EMAIL.test(email)) errors.email = 'That does not look like an email'

  if (password.length < MIN_PASSWORD) {
    errors.password = 'Use at least ' + MIN_PASSWORD + ' characters'
  }

  return errors
}
