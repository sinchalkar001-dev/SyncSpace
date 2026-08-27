import { nanoid } from '../utils/id.js'
import { Room } from '../models/Room.js'
import { Snapshot } from '../models/Snapshot.js'
import { DocUpdate } from '../models/DocUpdate.js'
import { Participant } from '../models/Participant.js'
import { getHocuspocus } from '../collab/registry.js'
import { getIo } from '../realtime/registry.js'
import { logger } from '../config/logger.js'
import { forbidden, notFound } from '../errors.js'

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

export async function inviteMember({ roomId, actorId, userId, role = 'editor' }) {
  const room = await getRoom(roomId)
  if (!room.owner || String(room.owner) !== String(actorId)) {
    throw forbidden('Only the room owner can invite people', 'not_owner')
  }
  if (room.hasMember(userId)) return room

  room.members.push({ user: userId, role })
  await room.save()
  return room
}

/** Public rooms are open to anyone; private rooms require membership. */
export function canAccess(room, userId) {
  if (!room) return false
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

/** Owner, invited members, and everyone who has actually opened the room. */
export async function listPeople(roomId) {
  const room = await getRoom(roomId)
  await room.populate([
    { path: 'owner', select: 'name email' },
    { path: 'members.user', select: 'name email' },
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
    participants: participants.map((participant) => participant.toPublic()),
  }
}

/**
 * Renames a room or flips its visibility. Owner only.
 *
 * Going private closes every live connection so anyone who just lost access
 * is forced to re-authenticate; members reconnect on their own.
 */
export async function updateRoom({ roomId, actorId, patch }) {
  const room = await getRoom(roomId)

  if (!room.owner || String(room.owner) !== String(actorId)) {
    throw forbidden('Only the room owner can change this room', 'not_owner')
  }

  const closing = patch.isPublic === false && room.isPublic === true

  if (patch.name !== undefined) room.name = patch.name
  if (patch.isPublic !== undefined) room.isPublic = patch.isPublic
  await room.save()

  if (closing) {
    try {
      getHocuspocus()?.closeConnections(roomId)
    } catch (error) {
      logger.warn({ err: error, room: roomId }, 'could not close connections after going private')
    }

    // Kick non-member users from Socket.io so they lose real-time access
    // immediately, matching the documented intent: "Going private closes every
    // live connection so anyone who just lost access is forced to
    // re-authenticate; members reconnect on their own."
    try {
      const io = getIo()
      if (io) {
        const sockets = await io.in(roomId).fetchSockets()
        const toKick = []
        const remaining = []

        for (const socket of sockets) {
          if (!room.hasMember(socket.data.user?.id)) {
            toKick.push(socket)
          } else {
            remaining.push(socket)
          }
        }

        for (const socket of toKick) {
          socket.emit('room:kicked', { roomId, reason: 'room_became_private' })
          socket.leave(roomId)
        }

        if (toKick.length > 0) {
          const members = remaining.map((s) => ({
            socketId: s.id,
            user: s.data.user,
          }))
          io.to(roomId).emit('room:presence', { roomId, members })
        }
      }
    } catch (error) {
      logger.warn(
        { err: error, room: roomId },
        'could not close socket connections after going private'
      )
    }
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
  const room = await getRoom(roomId)

  if (!room.owner || String(room.owner) !== String(actorId)) {
    throw forbidden('Only the room owner can delete this room', 'not_owner')
  }

  // Hang up anyone still in the room so they stop writing to it.
  try {
    getHocuspocus()?.closeConnections(roomId)
  } catch (error) {
    logger.warn({ err: error, room: roomId }, 'could not close collab connections on delete')
  }

  // Also disconnect Socket.io users from the deleted room
  try {
    const io = getIo()
    if (io) {
      const sockets = await io.in(roomId).fetchSockets()
      for (const socket of sockets) {
        socket.emit('room:kicked', { roomId, reason: 'room_deleted' })
        socket.leave(roomId)
        socket.data.roomId = null
      }
    }
  } catch (error) {
    logger.warn({ err: error, room: roomId }, 'could not close socket connections on delete')
  }

  const [updates] = await Promise.all([
    DocUpdate.collection.deleteMany({ roomId }),
    Snapshot.deleteOne({ roomId }),
    Participant.deleteMany({ roomId }),
  ])
  await Room.deleteOne({ roomId })

  logger.info({ room: roomId, updates: updates.deletedCount }, 'room deleted')
  return { roomId, deletedUpdates: updates.deletedCount }
}
