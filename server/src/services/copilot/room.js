import fs from 'node:fs/promises'
import path from 'node:path'
import * as Y from 'yjs'
import { File } from '../../models/File.js'
import { Snapshot } from '../../models/Snapshot.js'
import { DocUpdate } from '../../models/DocUpdate.js'
import { getHocuspocus } from '../../collab/registry.js'
import { UPLOAD_DIR } from '../../config/upload.js'
import { toUint8 } from '../../utils/binary.js'
import { logger } from '../../config/logger.js'

/**
 * What the copilot needs to know about a room: what is in its document, and
 * what a proposed file would actually do to its files.
 *
 * Both halves exist to keep one promise — that an answer describes the room
 * rather than describing whatever a caller said was in it, and that nothing is
 * replaced without first being shown.
 *
 * This was the readable half of the old "generate from whiteboard" service.
 * That feature is gone; these two jobs outlived it because the copilot does
 * the same two things better, and they live here now rather than in a service
 * named after a feature that no longer exists.
 */

/** Read at most this far back through the log if no snapshot exists. */
const MAX_REPLAY = 50_000

/** How much of an existing file to load so a modification can be reviewed. */
const MAX_DIFF_BYTES = 200_000

/**
 * Reads the room's document, from the freshest copy available.
 *
 * The server's own copy, never the request's. The client has a perfectly good
 * one and sending it would be a round trip shorter — but then the prompt, the
 * answer and the record would all describe whatever the caller claimed, and
 * what the copilot says about a room should not depend on which tab asked.
 *
 * A room being edited right now is in memory and is the freshest thing there
 * is. A room nobody has open is rebuilt the way `onLoadDocument` rebuilds it:
 * snapshot first, then the log written after it.
 */
async function withRoomDoc(roomId, read) {
  const live = getHocuspocus()?.documents?.get(roomId)
  if (live) return { value: read(live), source: 'live' }

  const snapshot = await Snapshot.findOne({ roomId }).lean()
  const doc = new Y.Doc()

  try {
    if (snapshot?.state) Y.applyUpdate(doc, toUint8(snapshot.state))

    const tail = await DocUpdate.find({ roomId, seq: { $gt: snapshot?.seq ?? 0 } })
      .sort({ seq: 1 })
      .limit(MAX_REPLAY)
      .lean()

    tail.forEach((entry) => Y.applyUpdate(doc, toUint8(entry.update)))

    return { value: read(doc), source: snapshot ? 'snapshot' : 'log' }
  } finally {
    doc.destroy()
  }
}

export async function readRoomShapes(roomId) {
  const { value, source } = await withRoomDoc(roomId, (doc) => doc.getArray('shapes').toJSON())
  return { shapes: value, source }
}

/**
 * The room's shared code buffer.
 *
 * Running code is the deliberate exception to reading the server's copy — see
 * the `/run` route, where the person is looking at their own keystrokes and
 * confusion about which version ran would be worse than a stale byte.
 */
export async function readRoomCode(roomId) {
  const { value, source } = await withRoomDoc(roomId, (doc) => doc.getText('code').toString())
  return { code: value, source }
}

/**
 * A room file name for a proposed path.
 *
 * Room files are a flat collection with one name each, and the upload service
 * reduces anything it is given to a basename — so `src/api/index.js` and
 * `src/db/index.js` would arrive as the same file. Flattening first keeps them
 * apart and keeps the path readable. The full path is kept on the proposal
 * either way; this is only what the artifact is called once written.
 */
export const roomFileNameFor = (proposedPath) => String(proposedPath).replace(/\//g, '_')

/** Existing room files, indexed by the name a proposed path would take. */
async function existingFilesByName(roomId) {
  const files = await File.find({ roomId })
    .select({ originalName: 1, storedName: 1, userId: 1, size: 1 })
    .lean()
  return new Map(files.map((file) => [file.originalName, file]))
}

/**
 * Decides what each proposed file actually does to this room.
 *
 * The model's own `action` is a suggestion and nothing more. It has not seen
 * the room's files, so "create" from it means "I wrote a new file", not "this
 * path is free" — a claim it is in no position to make. Anything landing on a
 * name that already exists becomes a modification here, whatever it called
 * itself, and it arrives carrying the current contents so the change can be
 * read before it is accepted. That is the whole of "do not blindly overwrite":
 * nothing is replaced that was not first shown.
 *
 * A delete naming a file the room does not have is dropped rather than kept as
 * a decision nobody can act on.
 */
export async function reconcileWithRoom(roomId, files) {
  const existing = await existingFilesByName(roomId)
  const reconciled = []
  const notes = []

  for (const file of files) {
    const name = roomFileNameFor(file.path)
    const match = existing.get(name)

    if (file.action === 'delete') {
      if (!match) {
        notes.push(
          'Ignored a proposed deletion of "' + file.path + '", which this room has no copy of.'
        )
        continue
      }
      reconciled.push({ ...file, action: 'delete', targetFileId: match._id, previous: null })
      continue
    }

    if (!match) {
      // Called it a modify but there is nothing here to modify: it is a new
      // file, and saying otherwise would promise a diff that cannot exist.
      if (file.action === 'modify') {
        notes.push(
          '"' + file.path + '" was proposed as a change, but this room has no such file yet.'
        )
      }
      reconciled.push({ ...file, action: 'create', targetFileId: null, previous: null })
      continue
    }

    const previous = await readRoomFileText(roomId, match).catch(() => null)
    if (file.action === 'create') {
      notes.push('"' + file.path + '" already exists in this room, so it is shown as a change.')
    }

    reconciled.push({ ...file, action: 'modify', targetFileId: match._id, previous })
  }

  return { files: reconciled, notes }
}

/**
 * The current text of a room file, so a change can be read before it is taken.
 *
 * Best effort. The file may be binary, may be larger than is worth sending to
 * a browser, or may have gone missing from disk — none of which should stop a
 * proposal being produced. A null here means the review shows the new file
 * without a comparison, which is a smaller loss than no proposal at all.
 */
async function readRoomFileText(roomId, file) {
  if (!file?.storedName || file.size > MAX_DIFF_BYTES) return null

  return fs.readFile(path.join(UPLOAD_DIR, roomId, file.storedName), 'utf8').catch((error) => {
    logger.debug(
      { room: roomId, file: String(file._id), code: error?.code },
      'could not read a room file'
    )
    return null
  })
}
