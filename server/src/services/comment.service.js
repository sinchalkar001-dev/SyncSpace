import * as Y from 'yjs'
import mongoose from 'mongoose'
import { nanoid } from '../utils/id.js'
import {
  CommentReadState,
  CommentThread,
  MAX_MESSAGES,
  MAX_THREADS_PER_ROOM,
} from '../models/Comment.js'
import { DocUpdate } from '../models/DocUpdate.js'
import { File } from '../models/File.js'
import { Participant } from '../models/Participant.js'
import { getIo } from '../realtime/registry.js'
import { CAPABILITIES, can } from '../permissions.js'
import { ACTIVITY, recordActivity } from './activity.service.js'
import { badRequest, forbidden, notFound } from '../errors.js'

/**
 * Comment threads: writing them, and telling the room.
 *
 * Every change is one atomic database update — a `$push` of the message and of
 * the event that records it, and a `$inc` of the version — rather than a read,
 * a modification and a save. Two people replying at the same moment both land,
 * in the order the database took them, and neither overwrites the other.
 *
 * Every change is then announced to the room with the whole thread. Threads
 * are small, and sending the whole thing means a client that missed an
 * announcement is corrected by the next one rather than drifting.
 */

const MAX_BODY = 4000
const MAX_MENTIONS = 20

const clampText = (value, max) => {
  const text = String(value ?? '').trim()
  return text.length > max ? text.slice(0, max) : text
}

const finite = (value) => (Number.isFinite(value) ? value : null)
const unit = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null)
const positiveInt = (value) => (Number.isInteger(value) && value >= 1 ? value : null)

/** How far a room's update log has got. Zero when the log is switched off. */
async function logPosition(roomId) {
  const last = await DocUpdate.findOne({ roomId }).sort({ seq: -1 }).select({ seq: 1 }).lean()
  return last?.seq ?? 0
}

/**
 * A relative position the client sent, checked to be one.
 *
 * The server cannot say where it points without the document, and does not
 * need to — the client resolves it. What the server can do is refuse bytes
 * that are not a relative position at all, so nothing reaches another client
 * that would throw when it tried to read it.
 */
function relativePosition(encoded) {
  if (!encoded) return null
  try {
    Y.decodeRelativePosition(new Uint8Array(Buffer.from(encoded, 'base64')))
    return encoded
  } catch {
    throw badRequest('anchor: not a valid position in the code', 'bad_anchor')
  }
}

/**
 * The anchor as it will be stored: only the fields its kind uses, each checked.
 *
 * A file anchor is looked up rather than believed. The file has to be one of
 * this room's, and its name comes from the database — a comment pointing at
 * another room's file, or relabelling one, is exactly what a client-supplied
 * label would allow.
 */
async function normaliseAnchor(roomId, anchor) {
  const label = anchor.label ? clampText(anchor.label, 120) : null

  switch (anchor.kind) {
    case 'shape':
      if (!anchor.shapeId) throw badRequest('anchor: a shape comment needs a shape', 'bad_anchor')
      return {
        kind: 'shape',
        shapeId: clampText(anchor.shapeId, 64),
        offsetX: unit(anchor.offsetX) ?? 0.5,
        offsetY: unit(anchor.offsetY) ?? 0.5,
        x: finite(anchor.x),
        y: finite(anchor.y),
        label,
      }

    case 'region':
      if (finite(anchor.x) === null || finite(anchor.y) === null) {
        throw badRequest('anchor: a board comment needs a position', 'bad_anchor')
      }
      return {
        kind: 'region',
        x: anchor.x,
        y: anchor.y,
        width: Math.max(0, finite(anchor.width) ?? 0),
        height: Math.max(0, finite(anchor.height) ?? 0),
        label,
      }

    case 'code': {
      const start = relativePosition(anchor.start)
      const end = relativePosition(anchor.end)
      const line = positiveInt(anchor.line)
      if (!start || !end || !line) {
        throw badRequest('anchor: a code comment needs a range', 'bad_anchor')
      }
      return {
        kind: 'code',
        start,
        end,
        line,
        endLine: Math.max(line, positiveInt(anchor.endLine) ?? line),
        startColumn: positiveInt(anchor.startColumn),
        endColumn: positiveInt(anchor.endColumn),
        snippet: anchor.snippet ? clampText(anchor.snippet, 280) : null,
        label,
      }
    }

    case 'file': {
      const file = mongoose.isValidObjectId(anchor.fileId)
        ? await File.findOne({ _id: anchor.fileId, roomId }).select({ originalName: 1 }).lean()
        : null
      if (!file) throw notFound('That file is not in this room', 'file_not_found')
      return { kind: 'file', fileId: String(file._id), label: clampText(file.originalName, 120) }
    }

    default:
      throw badRequest('anchor: unknown kind', 'bad_anchor')
  }
}

/**
 * The accounts a message may mention: people who belong to this room.
 *
 * In a public room anybody signed in can open it, so "can see the room" would
 * let a message ping every account on the server. Mentions are limited to the
 * people actually connected to the room — members, the owner, and accounts that
 * have opened it — and anybody the room has removed is dropped whatever else
 * is true of them.
 */
async function mentionable(room, ids) {
  const wanted = [...new Set((ids ?? []).map(String))]
    .filter((id) => mongoose.isValidObjectId(id))
    .slice(0, MAX_MENTIONS)
  if (!wanted.length) return []

  const visited = await Participant.find({ roomId: room.roomId, user: { $in: wanted } })
    .select({ user: 1 })
    .lean()
  const opened = new Set(visited.map((row) => String(row.user)))

  return wanted.filter(
    (id) => can(room, id, CAPABILITIES.ROOM_VIEW) && (room.hasMember(id) || opened.has(id))
  )
}

function body(value) {
  const text = clampText(value, MAX_BODY)
  if (!text) throw badRequest('A comment cannot be empty', 'empty_comment')
  return text
}

const authorOf = (user) => ({ id: user.id, name: clampText(user.name, 64) || null })

/**
 * Tells the room. `ref`, on a new thread only, is the author's own name for it
 * while it was being written: the announcement usually reaches the author's
 * client before the response does, and the ref lets that client swap its
 * placeholder for the saved thread instead of showing both until the response
 * catches up. It means nothing to anybody else and is never stored.
 */
function announce(roomId, thread, ref = null) {
  getIo()?.to(roomId).emit('comment:thread', ref ? { roomId, thread, ref } : { roomId, thread })
}

async function loadThread(roomId, threadId) {
  const thread = await CommentThread.findOne({ roomId, threadId })
  if (!thread) throw notFound('No such comment', 'comment_not_found')
  return thread
}

/* ---------- reading ---------- */

/** A room's threads, newest activity first, and when this person last looked. */
export async function listThreads(roomId, { userId } = {}) {
  const [threads, read] = await Promise.all([
    CommentThread.find({ roomId }).sort({ updatedAt: -1 }).limit(MAX_THREADS_PER_ROOM),
    userId ? CommentReadState.findOne({ user: userId, roomId }).lean() : null,
  ])

  return {
    threads: threads.map((thread) => thread.toPublic()),
    seenAt: read?.seenAt ?? null,
  }
}

/* ---------- writing ---------- */

export async function createThread({ room, user, anchor, text, mentions, ref = null }) {
  const count = await CommentThread.countDocuments({ roomId: room.roomId })
  if (count >= MAX_THREADS_PER_ROOM) {
    throw badRequest('This room has as many comment threads as it can hold', 'too_many_threads')
  }

  const [normalised, named, seq] = await Promise.all([
    normaliseAnchor(room.roomId, anchor),
    mentionable(room, mentions),
    logPosition(room.roomId),
  ])

  const author = authorOf(user)
  const now = new Date()
  const messageId = nanoid(10)

  const thread = await CommentThread.create({
    threadId: nanoid(12),
    roomId: room.roomId,
    anchor: normalised,
    messages: [
      { id: messageId, author: author.id, authorName: author.name, body: body(text), mentions: named, createdAt: now },
    ],
    events: [{ type: 'opened', by: author.id, byName: author.name, at: now, seq, messageId }],
    createdBy: author.id,
    createdByName: author.name,
    createdSeq: seq,
  })

  recordActivity({
    roomId: room.roomId,
    kind: ACTIVITY.COMMENT_POSTED,
    actor: author.id,
    actorName: author.name,
    detail: normalised.label || null,
    collapse: true,
  })

  const view = thread.toPublic()
  announce(room.roomId, view, typeof ref === 'string' && ref ? ref.slice(0, 64) : null)
  return view
}

export async function replyToThread({ room, threadId, user, text, mentions }) {
  const [named, seq] = await Promise.all([mentionable(room, mentions), logPosition(room.roomId)])
  const author = authorOf(user)
  const now = new Date()
  const messageId = nanoid(10)
  const words = body(text)

  // The cap is part of the filter, so two replies racing for the last slot
  // cannot both take it.
  const thread = await CommentThread.findOneAndUpdate(
    { roomId: room.roomId, threadId, ['messages.' + (MAX_MESSAGES - 1)]: { $exists: false } },
    {
      $push: {
        messages: { id: messageId, author: author.id, authorName: author.name, body: words, mentions: named, createdAt: now },
        events: { type: 'replied', by: author.id, byName: author.name, at: now, seq, messageId },
      },
      $inc: { version: 1 },
    },
    { new: true }
  )

  if (!thread) {
    await loadThread(room.roomId, threadId)
    throw badRequest('This thread has as many replies as it can hold', 'too_many_messages')
  }

  recordActivity({
    roomId: room.roomId,
    kind: ACTIVITY.COMMENT_POSTED,
    actor: author.id,
    actorName: author.name,
    detail: thread.anchor?.label || null,
    collapse: true,
  })

  const view = thread.toPublic()
  announce(room.roomId, view)
  return view
}

/**
 * Resolves or reopens a thread.
 *
 * Anybody who may comment may resolve, the way it works in every shared
 * document people already use: resolving is how a conversation says it is
 * finished, it is reversible, and the thread's events record who did it.
 *
 * Idempotent. Resolving a resolved thread changes nothing and records nothing,
 * so a click retried after a timeout does not leave two "resolved" events.
 */
export async function setThreadStatus({ room, threadId, user, resolved }) {
  const author = authorOf(user)
  const seq = await logPosition(room.roomId)
  const now = new Date()
  const next = resolved ? 'resolved' : 'open'

  const thread = await CommentThread.findOneAndUpdate(
    { roomId: room.roomId, threadId, status: resolved ? 'open' : 'resolved' },
    {
      $set: {
        status: next,
        resolvedBy: resolved ? author.id : null,
        resolvedByName: resolved ? author.name : null,
        resolvedAt: resolved ? now : null,
      },
      $push: { events: { type: resolved ? 'resolved' : 'reopened', by: author.id, byName: author.name, at: now, seq } },
      $inc: { version: 1 },
    },
    { new: true }
  )

  if (!thread) return (await loadThread(room.roomId, threadId)).toPublic()

  const view = thread.toPublic()
  announce(room.roomId, view)
  return view
}

/** Edits a message. Only its author may, and not once it has been deleted. */
export async function editMessage({ room, threadId, messageId, user, text, mentions }) {
  const current = await loadThread(room.roomId, threadId)
  const message = current.messages.find((entry) => entry.id === messageId && !entry.deletedAt)
  if (!message) throw notFound('No such comment', 'comment_not_found')
  if (String(message.author) !== String(user.id)) {
    throw forbidden('Only the person who wrote a comment can edit it', 'not_author')
  }

  const [named, seq] = await Promise.all([mentionable(room, mentions), logPosition(room.roomId)])
  const author = authorOf(user)
  const now = new Date()

  const thread = await CommentThread.findOneAndUpdate(
    { roomId: room.roomId, threadId },
    {
      $set: {
        'messages.$[m].body': body(text),
        'messages.$[m].mentions': named,
        'messages.$[m].editedAt': now,
      },
      $push: { events: { type: 'edited', by: author.id, byName: author.name, at: now, seq, messageId } },
      $inc: { version: 1 },
    },
    { new: true, arrayFilters: [{ 'm.id': messageId, 'm.deletedAt': null }] }
  )

  const view = thread.toPublic()
  announce(room.roomId, view)
  return view
}

/**
 * Deletes a message: its words go, its place in the thread stays.
 *
 * The author may delete their own; somebody who moderates comments may delete
 * anybody's. The text and the mentions are cleared rather than hidden — a
 * deleted comment should not be sitting in the database for whoever reads it
 * next — while the event that it existed, and when, is kept for the history.
 */
export async function deleteMessage({ room, threadId, messageId, user }) {
  const current = await loadThread(room.roomId, threadId)
  const message = current.messages.find((entry) => entry.id === messageId && !entry.deletedAt)
  if (!message) throw notFound('No such comment', 'comment_not_found')

  const own = String(message.author) === String(user.id)
  if (!own && !can(room, user.id, CAPABILITIES.COMMENT_MODERATE)) {
    throw forbidden('Only the author or a moderator can delete this comment', 'not_author')
  }

  const author = authorOf(user)
  const seq = await logPosition(room.roomId)
  const now = new Date()

  const thread = await CommentThread.findOneAndUpdate(
    { roomId: room.roomId, threadId },
    {
      $set: {
        'messages.$[m].body': '',
        'messages.$[m].mentions': [],
        'messages.$[m].deletedAt': now,
      },
      $push: { events: { type: 'deleted', by: author.id, byName: author.name, at: now, seq, messageId } },
      $inc: { version: 1 },
    },
    { new: true, arrayFilters: [{ 'm.id': messageId, 'm.deletedAt': null }] }
  )

  const view = thread.toPublic()
  announce(room.roomId, view)
  return view
}

/** Records that this person has now seen everything in the room's comments. */
export async function markSeen({ roomId, userId }) {
  const now = new Date()
  await CommentReadState.findOneAndUpdate(
    { user: userId, roomId },
    { $set: { seenAt: now }, $setOnInsert: { user: userId, roomId } },
    { upsert: true }
  )
  return { seenAt: now }
}
