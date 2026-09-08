import { Room } from '../models/Room.js'
import { User } from '../models/User.js'
import { forbidden, notFound } from '../errors.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { hashToken, randomToken } from '../utils/token.js'
import { ROLES, isRole } from '../permissions.js'

/**
 * Invitations that can be expired, spent and pointed at one address.
 *
 * An invitation used to be a row saying "this address is expected". That is
 * enough to let somebody in when they sign up, and not enough for anything
 * else: it could not expire, could not be used once, and could not be told
 * apart from a guess at an address. A room invited to in March was still
 * standing in December.
 *
 * A token fixes all three at once, and the rule that makes it worth having is
 * that it is *bound* — to the room and to the address it was sent to. A
 * forwarded invitation is not a way into somebody else's room, which is the
 * property an unbound token would quietly lose.
 */

const normalise = (email) => String(email ?? '').trim().toLowerCase()

const expiryFrom = (now = Date.now()) =>
  new Date(now + env.INVITATION_EXPIRY_HOURS * 60 * 60 * 1000)

/**
 * Issues a token for an invitation already held on `room`, replacing any
 * previous one.
 *
 * Re-inviting the same address supersedes rather than accumulates: two live
 * invitations to one room for one person is two things to revoke and one to
 * forget. Returns the raw token, which exists only here and in the email.
 */
export function issueInvitationToken(invite) {
  const raw = randomToken()

  invite.tokenHash = hashToken(raw)
  invite.expiresAt = expiryFrom()

  return raw
}

/** Where the invited person is sent. */
export const invitationLink = (token) => env.CLIENT_URL + '/accept-invitation?token=' + token

/**
 * Finds the room and invitation a token belongs to.
 *
 * Looked up by hash across every room, which is why the index exists. Returns
 * null for unknown, expired and already-spent alike — there is no branch here
 * that could tell somebody probing which of the three they hit.
 */
export async function findInvitation(raw) {
  if (!raw) return null

  const tokenHash = hashToken(raw)
  const room = await Room.findOne({ 'pendingInvites.tokenHash': tokenHash })
  if (!room) return null

  const invite = room.pendingInvites.find((entry) => entry.tokenHash === tokenHash)
  if (!invite) return null
  if (!invite.expiresAt || invite.expiresAt.getTime() <= Date.now()) return null

  return { room, invite }
}

/**
 * What the accept screen shows before anybody commits to anything.
 *
 * Deliberately thin: the room's name and who invited you, and nothing about
 * who else is in it or what else exists. An invitation is a key to one room,
 * not a directory.
 */
export async function describeInvitation(raw) {
  const found = await findInvitation(raw)
  if (!found) throw notFound('This invitation is invalid or has expired', 'invitation_invalid')

  const inviter = found.invite.invitedBy ? await User.findById(found.invite.invitedBy) : null

  return {
    roomId: found.room.roomId,
    roomName: found.room.name,
    role: found.invite.role,
    invitedBy: inviter?.name ?? null,
    expiresAt: found.invite.expiresAt,
  }
}

/**
 * Turns an invitation into a membership.
 *
 * Four things have to hold, and each closes something specific:
 *
 *  - the token resolves — otherwise it is expired, spent or invented
 *  - the account's address matches the one invited — otherwise a forwarded
 *    invitation is a way into a room it was never meant to reach
 *  - the address is verified — an invitation must not be a way around proving
 *    you can read the mailbox it was sent to
 *  - the person is not blocked — a removal outranks an old invitation
 *
 * Spending the invitation removes it, so a second attempt finds nothing. That
 * is what single-use means here: not a flag to check, but an absence.
 */
export async function acceptInvitation({ token, userId }) {
  const user = await User.findById(userId)
  if (!user) throw notFound('User not found', 'user_not_found')

  const found = await findInvitation(token)
  if (!found) throw notFound('This invitation is invalid or has expired', 'invitation_invalid')

  const { room, invite } = found

  if (normalise(user.email) !== normalise(invite.email)) {
    /**
     * Deliberately the same refusal as an unknown token.
     *
     * "This invitation is for somebody else" tells whoever is holding a
     * forwarded link which address it was meant for, which is exactly the
     * thing the binding is protecting.
     */
    logger.info(
      { room: room.roomId, user: String(user._id) },
      'invitation rejected: address does not match'
    )
    throw notFound('This invitation is invalid or has expired', 'invitation_invalid')
  }

  if (!user.emailVerified) {
    throw forbidden(
      'Verify your email address before accepting this invitation',
      'email_not_verified'
    )
  }

  if (room.isBlocked(user._id)) {
    throw forbidden('You do not have access to this room', 'room_forbidden')
  }

  const role = isRole(invite.role) && invite.role !== ROLES.OWNER ? invite.role : ROLES.EDITOR

  if (!room.hasMember(user._id)) room.members.push({ user: user._id, role })

  // Spent: removed rather than marked, so there is no "used" flag for a later
  // query to forget to filter on.
  room.pendingInvites = room.pendingInvites.filter((entry) => entry.tokenHash !== invite.tokenHash)
  await room.save()

  logger.info({ room: room.roomId, user: String(user._id), role }, 'invitation accepted')

  return { room, role }
}

/**
 * Turns every invitation waiting on this address into a membership.
 *
 * The gate is the point. Claiming at registration is what used to happen, and
 * it meant an invitation walked somebody straight past email verification: the
 * one thing the invitation was supposed to require was the one thing it
 * skipped. Now it claims only for an address that has actually been proven —
 * unless this deployment does not require verification at all, in which case
 * there is nothing to bypass and holding invitations back would only strand
 * people the owner has already vouched for.
 */
export async function claimInvitesFor(user) {
  if (env.REQUIRE_EMAIL_VERIFICATION && !user.emailVerified) return []

  const address = normalise(user.email)
  const waiting = await Room.find({ 'pendingInvites.email': address })
  const joined = []

  for (const room of waiting) {
    const invite = room.pendingInviteFor(address)

    /**
     * Where verification gates access, an invitation has to be presented.
     *
     * Claiming a tokened invitation automatically would consume it, and the
     * person would then follow the link in their email to be told it is
     * invalid — spent by something they never did. So when verification is
     * required, the token is the way in and this leaves it alone.
     *
     * When verification is not required there is nothing to gate, and taking
     * the automatic claim away would only add a step to a flow that has always
     * worked: sign up from an invitation and you are in the room.
     */
    if (env.REQUIRE_EMAIL_VERIFICATION && invite?.tokenHash) continue

    // A removal outranks an invitation that predates it.
    if (room.isBlocked(user._id)) continue

    room.pendingInvites = room.pendingInvites.filter((entry) => entry.email !== address)

    if (!room.hasMember(user._id)) {
      const role = isRole(invite?.role) && invite.role !== ROLES.OWNER ? invite.role : ROLES.EDITOR
      room.members.push({ user: user._id, role })
    }

    await room.save()
    joined.push(room.roomId)
  }

  if (joined.length) {
    logger.info({ user: String(user._id), rooms: joined }, 'pending invites claimed')
  }

  return joined
}

/** Refuses a token that is not even the right shape, before touching the database. */
export function looksLikeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

export { expiryFrom as invitationExpiry }
