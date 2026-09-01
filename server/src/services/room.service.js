import { nanoid } from '../utils/id.js'
import { Room } from '../models/Room.js'
import { User } from '../models/User.js'
import { Snapshot } from '../models/Snapshot.js'
import { DocUpdate } from '../models/DocUpdate.js'
import { Participant } from '../models/Participant.js'
import { getHocuspocus } from '../collab/registry.js'
import { getIo } from '../realtime/registry.js'
import { sendRoomInviteEmail } from './email.service.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { badRequest, forbidden, notFound } from '../errors.js'

/**
 * Close frame for a collab connection the server no longer wants.
 *
 * 4205 is Hocuspocus's "Reset Connection": the provider hangs up and comes
 * straight back, and that reconnect is what re-runs onAuthenticate — so the
 * person who just lost access gets a real authentication failure, and the room
 * gate can say why. Closing with 4403 would look more apt and behave worse:
 * the provider treats it as final, never retries, and leaves them staring at a
 * stale document that has quietly stopped syncing.
 */
const RECONNECT_FRAME = { code: 4205, reason: 'Reset Connection' }

/**
 * Rooms opened by URL are created on demand and are public, which keeps
 * ad-hoc sessions working. Rooms created through the API are invite-only.
 */
export async function ensureRoom(roomId) {
  return Room.findOneAndUpdate(
    { roomId },
    { $setOnInsert: { roomId, isPublic: true }, $set: { lastActivityAt: new Date() } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
}

export async function createRoom({ name, ownerId, isPublic = false }) {
  const roomId = nanoid(8)
  return Room.create({
    roomId,
    name: name || 'Untitled room',
    owner: ownerId,
    isPublic,
    members: ownerId ? [{ user: ownerId, role: 'owner' }] : [],
  })
}

export async function getRoom(roomId) {
  const room = await Room.findOne({ roomId })
  if (!room) throw notFound('Room not found', 'room_not_found')
  return room
}

/** Loads a room for an operation only its owner may perform. */
async function ownedRoom(roomId, actorId, message) {
  const room = await getRoom(roomId)
  if (!room.owner || String(room.owner) !== String(actorId)) {
    throw forbidden(message, 'not_owner')
  }
  return room
}

/**
 * Hangs up everyone in a room whose identity `matches`.
 *
 * Both transports have to be told. The Socket.io channel carries presence and
 * is where a client learns it was removed; Hocuspocus carries the document
 * itself, and leaving that one open would let someone who just lost access
 * carry on typing on the whiteboard.
 *
 * Failures are logged, never thrown: the membership change is already written,
 * and any connection that survives is refused at its next authentication.
 */
async function hangUp({ roomId, reason, matches }) {
  try {
    const document = getHocuspocus()?.documents?.get(roomId)
    for (const { connection } of document?.connections?.values() ?? []) {
      if (matches(connection.context?.user)) connection.close(RECONNECT_FRAME)
    }
  } catch (error) {
    logger.warn({ err: error, room: roomId }, 'could not close collab connections')
  }

  try {
    const io = getIo()
    if (!io) return

    const sockets = await io.in(roomId).fetchSockets()
    const removed = sockets.filter((socket) => matches(socket.data.user))

    for (const socket of removed) {
      socket.emit('room:kicked', { roomId, reason })
      socket.leave(roomId)
      socket.data.roomId = null
    }

    if (removed.length > 0) {
      const members = sockets
        .filter((socket) => !removed.includes(socket))
        .map((socket) => ({ socketId: socket.id, user: socket.data.user }))
      io.to(roomId).emit('room:presence', { roomId, members })
    }
  } catch (error) {
    logger.warn({ err: error, room: roomId }, 'could not close socket connections')
  }
}

/** The account being invited or removed, by id or by the email people know. */
async function findAccount({ userId, email }) {
  const user = email
    ? await User.findOne({ email: String(email).trim().toLowerCase() })
    : await User.findById(userId)

  if (!user) {
    throw notFound(
      email ? 'Nobody is signed up with that email address' : 'No such user',
      'user_not_found'
    )
  }
  return user
}

/**
 * How long an invite waits on the mail relay before answering anyway.
 *
 * The membership is saved before this starts, so a slow relay must never hold
 * up the reply. Gmail takes the better part of four seconds for a single
 * message — TCP, STARTTLS, AUTH and the message itself, on a fresh connection
 * every time — so anything tighter turns the usual case into a coin flip.
 * This is sized to clear that comfortably; it only bites when a relay is
 * genuinely wedged.
 */
const NOTIFY_TIMEOUT_MS = 10000

/**
 * Tells the invitee they are in, and hands them the way to get there.
 *
 * A private room shows nothing to anyone outside it, so without this an invite
 * is silent: the room turns up on their dashboard and they have no reason to
 * look. Failure is reported, never thrown — the membership is already written,
 * and refusing an invite that worked would be the worse answer.
 *
 * Answers true when the relay took the message, false when it refused, and
 * null when the deadline came first and the send is still going. That third
 * answer matters: reporting a slow send as a failure sends the owner chasing
 * their guest with a code that is already in their inbox.
 */
async function notifyInvitee({ room, invitee, inviter }) {
  const PENDING = Symbol('still sending')

  const sent = sendRoomInviteEmail(invitee.email, {
    inviter: inviter?.name,
    room: room.name,
    code: room.roomId,
    url: env.CLIENT_URL + '/room/' + encodeURIComponent(room.roomId),
  }).catch((error) => {
    logger.warn({ err: error, room: room.roomId }, 'could not send the invite email')
    return { delivered: false }
  })

  const deadline = new Promise((resolve) => {
    // Unreferenced: an invite still in the relay must not hold the process open.
    setTimeout(resolve, NOTIFY_TIMEOUT_MS, PENDING).unref?.()
  })

  const result = await Promise.race([sent, deadline])
  return result === PENDING ? null : result.delivered
}

/**
 * Adds someone to a room. Owner only.
 *
 * An invite is also the way back in for someone who was removed, so it clears
 * any block — otherwise inviting a person you had kicked would look like it
 * worked and then refuse them at the door.
 *
 * Answers with the room and who was let in, including whether the invitation
 * email reached the relay: a private room that nobody was told about is the
 * same as no invite at all.
 */
export async function inviteMember({ roomId, actorId, userId, email, role = 'editor' }) {
  const room = await ownedRoom(roomId, actorId, 'Only the room owner can invite people')
  const invitee = await findAccount({ userId, email })
  const inviteeId = invitee._id.toString()

  const blocked = room.isBlocked(inviteeId)
  const member = room.hasMember(inviteeId)

  if (blocked || !member) {
    if (blocked) room.blocked = room.blocked.filter((entry) => String(entry.user) !== inviteeId)
    if (!member) room.members.push({ user: inviteeId, role })
    await room.save()
    logger.info({ room: roomId, user: inviteeId }, 'member invited')
  }

  // Sent even when the membership was already there, so pressing Invite again
  // is how an owner re-sends a code their guest never received. The invite
  // limiter is what stops that becoming a way to mail somebody at will.
  const notified = await notifyInvitee({ room, invitee, inviter: await User.findById(actorId) })

  return {
    room,
    invited: { id: inviteeId, name: invitee.name, email: invitee.email, notified },
  }
}

/**
 * Removes someone from a room and keeps them out. Owner only.
 *
 * Dropping the membership is enough for a private room, but a public one is
 * open to anyone holding the link, so the person is recorded as blocked as
 * well and refused by canAccess whichever way the room is set. Their live
 * connections close immediately rather than at their next reload, and their
 * visit history goes too — a roster that lists someone as both removed and
 * present reads like two different people.
 */
export async function removeMember({ roomId, actorId, userId }) {
  const room = await ownedRoom(roomId, actorId, 'Only the room owner can remove people')
  const target = await findAccount({ userId })
  const targetId = target._id.toString()

  if (String(room.owner) === targetId) {
    throw badRequest('The room owner cannot be removed', 'cannot_remove_owner')
  }

  room.members = room.members.filter((member) => String(member.user) !== targetId)
  if (!room.isBlocked(targetId)) room.blocked.push({ user: targetId, at: new Date() })
  await room.save()

  await Participant.deleteMany({ roomId, user: targetId })
  await hangUp({
    roomId,
    reason: 'removed_by_owner',
    matches: (user) => Boolean(user?.id) && String(user.id) === targetId,
  })

  logger.info({ room: roomId, user: targetId }, 'member removed')
  return { room, removed: { id: targetId, name: target.name, email: target.email } }
}

/** Lets a removed person back in, as far as the room's own rules allow. */
export async function unblockMember({ roomId, actorId, userId }) {
  const room = await ownedRoom(roomId, actorId, 'Only the room owner can remove people')
  const id = String(userId)

  room.blocked = room.blocked.filter((entry) => String(entry.user) !== id)
  await room.save()

  logger.info({ room: roomId, user: id }, 'member unblocked')
  return room
}

/**
 * Public rooms are open to anyone; private rooms require membership. Someone
 * the owner has removed is refused either way.
 */
export function canAccess(room, userId) {
  if (!room) return false
  if (room.isBlocked(userId)) return false
  if (room.isPublic) return true
  return room.hasMember(userId)
}

export async function listRoomsForUser(userId) {
  return Room.find({ $or: [{ owner: userId }, { 'members.user': userId }] })
    .sort({ lastActivityAt: -1 })
    .limit(50)
}

/**
 * Notes that someone opened a room. Idempotent per visitor, so a person who
 * rejoins updates their row rather than adding another.
 *
 * The userKey uses the account id for authenticated users and a per-socket
 * unique id for anonymous visitors so two guests who happen to pick the same
 * display name do not share a row.
 */
export async function recordParticipant({ roomId, user }) {
  if (!roomId || !user) return null

  const name = String(user.name || 'Guest').slice(0, 64)
  const isGuest = user.anonymous === true || (user.anonymous === undefined && !user.id)
  const userKey = isGuest ? 'guest:' + (user.id || name) : 'user:' + user.id
  const now = new Date()

  return Participant.findOneAndUpdate(
    { roomId, userKey },
    {
      $set: { name, guest: isGuest, user: isGuest ? null : user.id, lastSeenAt: now },
      $setOnInsert: { roomId, userKey, firstSeenAt: now },
      $inc: { visits: 1 },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
}

/** Owner, invited members, anyone removed, and everyone who has opened the room. */
export async function listPeople(roomId) {
  const room = await getRoom(roomId)
  await room.populate([
    { path: 'owner', select: 'name email' },
    { path: 'members.user', select: 'name email' },
    { path: 'blocked.user', select: 'name email' },
  ])

  const participants = await Participant.find({ roomId }).sort({ lastSeenAt: -1 }).limit(100)

  return {
    owner: room.owner
      ? { id: room.owner._id.toString(), name: room.owner.name, email: room.owner.email }
      : null,
    members: room.members
      .filter((member) => member.user)
      .map((member) => ({
        id: member.user._id.toString(),
        name: member.user.name,
        email: member.user.email,
        role: member.role,
      })),
    blocked: room.blocked
      .filter((entry) => entry.user)
      .map((entry) => ({
        id: entry.user._id.toString(),
        name: entry.user.name,
        email: entry.user.email,
        at: entry.at,
      })),
    participants: participants.map((participant) => participant.toPublic()),
  }
}

/**
 * Renames a room or flips its visibility. Owner only.
 *
 * Going private closes every connection that no longer belongs, so anyone who
 * just lost access is forced to re-authenticate; members stay where they are.
 * It is also the only way to clear guests out of a room, since an anonymous
 * visitor has no account to remove.
 */
export async function updateRoom({ roomId, actorId, patch }) {
  const room = await ownedRoom(roomId, actorId, 'Only the room owner can change this room')

  const closing = patch.isPublic === false && room.isPublic === true

  if (patch.name !== undefined) room.name = patch.name
  if (patch.isPublic !== undefined) room.isPublic = patch.isPublic
  await room.save()

  if (closing) {
    await hangUp({
      roomId,
      reason: 'room_became_private',
      matches: (user) => !room.hasMember(user?.id),
    })
  }

  logger.info({ room: roomId, patch }, 'room updated')
  return room
}

/**
 * Removes a room and everything belonging to it.
 *
 * The update log is append-only at the model layer, which is what protects
 * history from being rewritten. Discarding a room outright is a different
 * operation from tampering with it, so this one purge goes through the driver
 * deliberately, bypassing that guard.
 */
export async function deleteRoom({ roomId, actorId }) {
  const room = await ownedRoom(roomId, actorId, 'Only the room owner can delete this room')

  // Hang up everyone still in the room so they stop writing to it.
  await hangUp({ roomId, reason: 'room_deleted', matches: () => true })

  const [updates] = await Promise.all([
    DocUpdate.collection.deleteMany({ roomId }),
    Snapshot.deleteOne({ roomId }),
    Participant.deleteMany({ roomId }),
  ])
  await Room.deleteOne({ roomId })

  logger.info({ room: room.roomId, updates: updates.deletedCount }, 'room deleted')
  return { roomId, deletedUpdates: updates.deletedCount }
}
