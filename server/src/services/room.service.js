import { nanoid } from '../utils/id.js'
import { Room } from '../models/Room.js'
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
