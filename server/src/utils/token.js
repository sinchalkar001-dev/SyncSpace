import { createHash, randomBytes } from 'node:crypto'

/**
 * Single-use secrets sent by email — confirmation links and password resets.
 *
 * Both flows want the same two things, and they want them to agree: a token
 * random enough not to be guessed, and a database that never holds the value
 * the email carries. Keeping one implementation means a change to either
 * property applies to both, rather than to whichever file someone remembered.
 */

/** 32 bytes of CSPRNG output, hex encoded — the value that goes in the email. */
export const randomToken = () => randomBytes(32).toString('hex')

/**
 * What gets persisted.
 *
 * SHA-256 rather than bcrypt on purpose: these are already 256 bits of
 * uniform randomness, so there is no low-entropy guess for a slow hash to
 * frustrate, and the lookup is a single indexed find rather than a scan
 * comparing every row.
 */
export const hashToken = (raw) => createHash('sha256').update(raw).digest('hex')

/** The shape both flows validate before spending a database lookup on it. */
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/

/**
 * The `jti` of a new token — the name of the session row it belongs to.
 *
 * Sixteen bytes rather than the thirty-two above, and for a different reason:
 * this is not a secret. It travels inside the JWT, where the person holding it
 * can read it, and it only has to be unique. It is still generated rather than
 * derived, because a guessable one would let somebody name a session they do
 * not hold on the endpoints that revoke by id.
 */
export const newSessionId = () => randomBytes(16).toString('hex')
