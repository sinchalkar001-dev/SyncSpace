import mongoose from 'mongoose'

/**
 * A comment thread, attached to something in a room.
 *
 * Kept out of the Yjs document on purpose, for three reasons that each rule it
 * out alone. A commenter's collab connection is read-only — the role exists
 * precisely to talk about work without changing it — so a thread stored in the
 * document could never be written by the people it is for. A CRDT has no
 * server that can say no, so "optimistic UI with rollback" would have nothing
 * to roll back from. And every resolve and reply would become a permanent
 * update in the log, forever replayed, for something that is not the work.
 *
 * So threads live here, behind permission-checked requests, and are announced
 * to the room over its socket. What ties them to the work is the anchor.
 *
 * And what keeps them meaningful in replay is `events`: an append-only record
 * of everything that happened to the thread — opened, replied, resolved,
 * reopened, edited, deleted — each stamped with the time and with the position
 * the update log had reached. A replay at position N shows the threads that
 * existed then, in the state they were in then. A deleted message keeps its
 * event and loses its words, so the history stays honest without keeping what
 * somebody chose to remove.
 */

export const ANCHOR_KINDS = Object.freeze(['shape', 'region', 'code', 'file'])

export const THREAD_EVENTS = Object.freeze([
  'opened',
  'replied',
  'resolved',
  'reopened',
  'edited',
  'deleted',
])

/** Enough for any real conversation, and a ceiling on a runaway one. */
export const MAX_MESSAGES = 200
export const MAX_THREADS_PER_ROOM = 2000

/**
 * What a thread is attached to.
 *
 *   shape    a whiteboard shape, and where on it (as a fraction of its bounds),
 *            so the pin travels with the shape when it moves or is resized.
 *            `x`/`y` keep the last known place, for when the shape is deleted.
 *   region   a point (zero size) or a rectangle on the board.
 *   code     a range of the room's code, as two Yjs relative positions. These
 *            follow the text through everybody's edits, which line numbers
 *            cannot; the line numbers and snippet are kept as they were when
 *            the comment was made, for display and for when the text is gone.
 *   file     one of the room's files.
 *
 * `label` is what the thing was called when the comment was made — a shape's
 * text, a file's name — so a comment on something since deleted still says
 * what it was about.
 */
const anchorSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ANCHOR_KINDS, required: true },

    shapeId: { type: String, default: null, maxlength: 64 },
    offsetX: { type: Number, default: null },
    offsetY: { type: Number, default: null },

    x: { type: Number, default: null },
    y: { type: Number, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },

    start: { type: String, default: null, maxlength: 512 },
    end: { type: String, default: null, maxlength: 512 },
    line: { type: Number, default: null },
    endLine: { type: Number, default: null },
    startColumn: { type: Number, default: null },
    endColumn: { type: Number, default: null },
    snippet: { type: String, default: null, maxlength: 280 },

    fileId: { type: String, default: null, maxlength: 64 },

    label: { type: String, default: null, maxlength: 120 },
  },
  { _id: false }
)

const messageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, default: null, maxlength: 64 },
    body: { type: String, default: '', maxlength: 4000 },
    /** Accounts named in the message, checked against the room when written. */
    mentions: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    createdAt: { type: Date, default: Date.now },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { _id: false }
)

const eventSchema = new mongoose.Schema(
  {
    type: { type: String, enum: THREAD_EVENTS, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: null, maxlength: 64 },
    at: { type: Date, default: Date.now },
    /** How far the update log had got, so replay can place the event. */
    seq: { type: Number, default: 0 },
    messageId: { type: String, default: null },
  },
  { _id: false }
)

const commentThreadSchema = new mongoose.Schema(
  {
    threadId: { type: String, required: true },
    roomId: { type: String, required: true },

    anchor: { type: anchorSchema, required: true },

    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedByName: { type: String, default: null, maxlength: 64 },
    resolvedAt: { type: Date, default: null },

    messages: { type: [messageSchema], default: [] },
    events: { type: [eventSchema], default: [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, default: null, maxlength: 64 },
    createdSeq: { type: Number, default: 0 },

    /**
     * Bumped by every change. Clients keep whichever copy of a thread has the
     * higher version, so an announcement that overtakes the response to the
     * request that caused it cannot roll anybody's view backwards.
     */
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
)

commentThreadSchema.index({ threadId: 1 }, { unique: true })
// A room's threads, newest activity first — the only list read on page load.
commentThreadSchema.index({ roomId: 1, updatedAt: -1 })

commentThreadSchema.methods.toPublic = function toPublic() {
  const anchor = this.anchor?.toObject ? this.anchor.toObject() : { ...this.anchor }

  return {
    id: this.threadId,
    roomId: this.roomId,
    anchor,
    status: this.status,
    resolvedBy: this.resolvedBy ? String(this.resolvedBy) : null,
    resolvedByName: this.resolvedByName,
    resolvedAt: this.resolvedAt,
    messages: this.messages.map((message) => ({
      id: message.id,
      author: String(message.author),
      authorName: message.authorName,
      body: message.deletedAt ? '' : message.body,
      mentions: message.deletedAt ? [] : message.mentions.map(String),
      createdAt: message.createdAt,
      editedAt: message.editedAt,
      deleted: Boolean(message.deletedAt),
    })),
    events: this.events.map((event) => ({
      type: event.type,
      by: event.by ? String(event.by) : null,
      byName: event.byName,
      at: event.at,
      seq: event.seq,
      messageId: event.messageId,
    })),
    createdBy: String(this.createdBy),
    createdByName: this.createdByName,
    createdSeq: this.createdSeq,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    version: this.version,
  }
}

export const CommentThread = mongoose.model('CommentThread', commentThreadSchema)

/**
 * When somebody last looked at a room's comments.
 *
 * What the notification indicator counts from. One row per person per room,
 * written when they open the comments panel; everything newer than it, by
 * somebody else, is news.
 */
const commentReadStateSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    roomId: { type: String, required: true },
    seenAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
)

commentReadStateSchema.index({ user: 1, roomId: 1 }, { unique: true })

export const CommentReadState = mongoose.model('CommentReadState', commentReadStateSchema)
