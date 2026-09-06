import fs from 'node:fs/promises'
import path from 'node:path'
import * as Y from 'yjs'
import { Generation } from '../models/Generation.js'
import { File } from '../models/File.js'
import { Snapshot } from '../models/Snapshot.js'
import { DocUpdate } from '../models/DocUpdate.js'
import { getHocuspocus } from '../collab/registry.js'
import { UPLOAD_DIR } from '../config/upload.js'
import { toUint8 } from '../utils/binary.js'
import { logger } from '../config/logger.js'
import { badRequest, notFound } from '../errors.js'
import { extractArchitecture } from './architecture.service.js'
import { askForImplementation, TARGET_KEYS } from './ai.service.js'
import { deleteFile, uploadFile } from './file.service.js'

/**
 * "Generate from whiteboard", from reading the board to writing the files.
 *
 * The shape of this file follows one rule: the model proposes, the server
 * decides, and the person accepts. Nothing the model returns is acted on
 * without passing through a decision made here and a decision made by a
 * human — which is what keeps a confident wrong answer from being a
 * destructive one.
 */

/** Read shapes at most this far back through the log if no snapshot exists. */
const MAX_REPLAY = 50_000

/** How much of an existing file to load so a modification can be reviewed. */
const MAX_DIFF_BYTES = 200_000

/**
 * The room's shapes, as the server understands them.
 *
 * Read from the server's own copy rather than taken from the request. The
 * client has a perfectly good copy, and sending it would be one round trip
 * shorter — but then the graph, the prompt and the record would all describe
 * whatever the caller said was on the board, and a room's generated code
 * should not depend on which tab asked for it.
 *
 * A room being edited right now is in memory and is the freshest thing there
 * is. A room nobody has open is rebuilt the way `onLoadDocument` rebuilds it:
 * snapshot first, then the log written after it.
 */
export async function readRoomShapes(roomId) {
  const live = getHocuspocus()?.documents?.get(roomId)
  if (live) {
    return { shapes: live.getArray('shapes').toJSON(), source: 'live' }
  }

  const snapshot = await Snapshot.findOne({ roomId }).lean()
  const doc = new Y.Doc()

  try {
    if (snapshot?.state) Y.applyUpdate(doc, toUint8(snapshot.state))

    const tail = await DocUpdate.find({ roomId, seq: { $gt: snapshot?.seq ?? 0 } })
      .sort({ seq: 1 })
      .limit(MAX_REPLAY)
      .lean()

    tail.forEach((entry) => Y.applyUpdate(doc, toUint8(entry.update)))

    return { shapes: doc.getArray('shapes').toJSON(), source: snapshot ? 'snapshot' : 'log' }
  } finally {
    doc.destroy()
  }
}

/** The architecture graph for a room, with no model involved. */
export async function readArchitecture(roomId) {
  const { shapes, source } = await readRoomShapes(roomId)
  return { ...extractArchitecture(shapes), source }
}

/**
 * A room file name for a proposed path.
 *
 * Room files are a flat collection with one name each, and the upload service
 * reduces anything it is given to a basename — so `src/api/index.js` and
 * `src/db/index.js` would arrive as the same file. Flattening first keeps them
 * apart and keeps the path readable. The full path is kept on the change set
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
 * path is free — a claim it is in no position to make. Anything landing on a
 * name that already exists becomes a modification here, whatever it called
 * itself, and it arrives carrying the current contents so the change can be
 * read before it is accepted. That is the whole of "do not blindly
 * overwrite": nothing is replaced that was not first shown.
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
        notes.push('Ignored a proposed deletion of "' + file.path + '", which this room has no copy of.')
        continue
      }
      reconciled.push({ ...file, action: 'delete', targetFileId: match._id, previous: null })
      continue
    }

    if (!match) {
      // Called it a modify but there is nothing here to modify: it is a new
      // file, and saying otherwise would promise a diff that cannot exist.
      if (file.action === 'modify') {
        notes.push('"' + file.path + '" was proposed as a change, but this room has no such file yet.')
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
 * change set being produced. A null here means the review shows the new file
 * without a comparison, which is a smaller loss than no change set at all.
 */
async function readRoomFileText(roomId, file) {
  if (!file?.storedName || file.size > MAX_DIFF_BYTES) return null

  return fs.readFile(path.join(UPLOAD_DIR, roomId, file.storedName), 'utf8').catch((error) => {
    logger.debug({ room: roomId, file: String(file._id), code: error?.code }, 'could not read a room file')
    return null
  })
}

/** Checks the requested targets, which come straight from a request body. */
export function normaliseTargets(targets) {
  const list = Array.isArray(targets) ? [...new Set(targets)] : []
  const unknown = list.filter((target) => !TARGET_KEYS.includes(target))
  if (unknown.length > 0) {
    throw badRequest('Unknown target: ' + unknown.join(', '), 'bad_target')
  }
  if (list.length === 0) throw badRequest('Choose at least one thing to generate', 'no_targets')
  return TARGET_KEYS.filter((key) => list.includes(key))
}

/**
 * Runs a generation and records it, succeeded or failed.
 *
 * A failure is stored rather than only thrown. The person waited a minute for
 * it, and "the model was cut off" is worth seeing in the room's history
 * alongside the runs that worked — otherwise a room where generation keeps
 * failing looks like a room where nobody ever tried.
 */
export async function runGeneration({ roomId, user, targets, intent }) {
  const chosen = normaliseTargets(targets)
  const started = Date.now()

  const architecture = await readArchitecture(roomId)
  const { source: _source, ...graph } = architecture

  const record = {
    roomId,
    requestedBy: user.id,
    requestedByName: user.name ?? null,
    targets: chosen,
    intent: intent ? String(intent).slice(0, 2000) : null,
    architecture: graph,
  }

  let answer
  try {
    answer = await askForImplementation({ architecture: graph, targets: chosen, intent })
  } catch (error) {
    const failure = await Generation.create({
      ...record,
      status: 'failed',
      error: String(error?.message ?? 'Generation failed').slice(0, 300),
      durationMs: Date.now() - started,
    })
    // Rethrown as well as recorded: the caller is still waiting for an answer,
    // and a 200 with a failed record inside it would be a worse API.
    error.generation = failure.toSummary()
    throw error
  }

  const { files, notes } = await reconcileWithRoom(roomId, answer.proposal.files)

  const generation = await Generation.create({
    ...record,
    status: 'succeeded',
    summary: answer.proposal.summary,
    plan: answer.proposal.plan,
    assumptions: answer.proposal.assumptions,
    questions: answer.proposal.questions,
    rejected: [...answer.proposal.rejected, ...notes],
    files: files.map((file) => ({
      path: file.path,
      action: file.action,
      language: file.language,
      contents: file.contents,
      rationale: file.rationale,
      size: file.size,
      status: 'proposed',
    })),
    model: answer.model,
    usage: answer.usage,
    durationMs: Date.now() - started,
  })

  return withPrevious(roomId, generation.toPublic())
}

/**
 * Attaches, to each modification, the contents it would replace.
 *
 * Computed on read rather than stored. Keeping a copy would double the space a
 * change set costs for no gain, and — the real reason — it would go stale: a
 * change set opened tomorrow should be compared against the file as it is
 * *now*, not against what it was when the model answered. If somebody has
 * edited it in between, that is exactly what the reviewer needs to see.
 */
export async function withPrevious(roomId, payload) {
  const modifications = payload.files.filter((file) => file.action === 'modify')

  // Every file carries the field either way, so a caller never has to tell
  // "nothing to compare against" from "this shape does not have that key".
  if (modifications.length === 0) {
    return { ...payload, files: payload.files.map((file) => ({ ...file, previous: null })) }
  }

  const existing = await existingFilesByName(roomId)
  const contents = new Map()

  for (const file of modifications) {
    const match = existing.get(roomFileNameFor(file.path))
    contents.set(file.path, match ? await readRoomFileText(roomId, match) : null)
  }

  return {
    ...payload,
    files: payload.files.map((file) => ({
      ...file,
      previous: file.action === 'modify' ? (contents.get(file.path) ?? null) : null,
    })),
  }
}

/** The room's AI history, newest first. */
export async function listGenerations(roomId, { limit = 20 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 50)
  const rows = await Generation.find({ roomId }).sort({ createdAt: -1 }).limit(capped)
  return rows.map((row) => row.toSummary())
}

export async function getGeneration(roomId, generationId) {
  if (!/^[0-9a-f]{24}$/i.test(String(generationId))) {
    throw badRequest('That is not a generation id', 'bad_generation_id')
  }

  // Scoped to the room in the query, so a generation id from another room is
  // simply not found rather than checked and refused.
  const generation = await Generation.findOne({ _id: generationId, roomId })
  if (!generation) throw notFound('No such generation in this room', 'generation_not_found')
  return generation
}

/**
 * Applies the files somebody accepted, and marks the rest rejected.
 *
 * Partial by construction: the caller names what it wants, and what it does
 * not name is turned down rather than left hanging. A change set with no
 * decision recorded is worse than either answer, because nothing downstream
 * can tell "not looked at yet" from "looked at and declined".
 *
 * Each file is applied on its own and a failure is recorded against that file
 * rather than thrown. Half a change set applied with a clear note on the two
 * that did not is a far better place to be than a rollback of work somebody
 * has just reviewed — and every one of these writes is independent, so there
 * is nothing to be consistent with.
 */
export async function applyGeneration({ roomId, generationId, user, accept = [] }) {
  const generation = await getGeneration(roomId, generationId)

  if (generation.status !== 'succeeded') {
    throw badRequest('That generation did not produce anything to apply', 'generation_failed')
  }

  const wanted = new Set(accept.map(String))
  const unknown = [...wanted].filter(
    (id) => !generation.files.some((file) => String(file._id) === id)
  )
  if (unknown.length > 0) {
    throw badRequest('That change set has no file ' + unknown[0], 'unknown_file')
  }

  let applied = 0
  let rejectedCount = 0
  let failed = 0

  for (const file of generation.files) {
    // Already decided; applying twice would write a second copy.
    if (file.status !== 'proposed') continue

    if (!wanted.has(String(file._id))) {
      file.status = 'rejected'
      rejectedCount += 1
      continue
    }

    try {
      const fileId = await applyOneFile({ roomId, user, file })
      file.status = 'applied'
      file.appliedFileId = fileId
      file.appliedAt = new Date()
      file.error = null
      applied += 1
    } catch (error) {
      // Left `proposed`, deliberately: it has not been rejected, and the
      // person should be able to fix the cause and press apply again.
      file.error = String(error?.message ?? 'Could not apply this file').slice(0, 300)
      failed += 1
      logger.warn({ err: error, room: roomId, path: file.path }, 'could not apply a generated file')
    }
  }

  await generation.save()

  return { generation: generation.toPublic(), applied, rejected: rejectedCount, failed }
}

/** Writes one accepted file into the room's files. Answers its id, or throws. */
async function applyOneFile({ roomId, user, file }) {
  const name = roomFileNameFor(file.path)

  if (file.action === 'delete') {
    const existing = await File.findOne({ roomId, originalName: name }).select({ _id: 1 }).lean()
    if (!existing) throw new Error('This room no longer has a file called ' + name)
    // Through the file service, so the same rule applies as anywhere else:
    // only the uploader or the room owner may remove one.
    await deleteFile(String(existing._id), { userId: user.id })
    return null
  }

  if (file.action === 'modify') {
    const existing = await File.findOne({ roomId, originalName: name }).select({ _id: 1 }).lean()
    // Replaced rather than added beside: the change set said modify, the
    // person saw what it would replace, and two files with one name would be
    // a worse answer than either.
    if (existing) await deleteFile(String(existing._id), { userId: user.id })
  }

  const buffer = Buffer.from(file.contents, 'utf8')
  const created = await uploadFile({
    roomId,
    userId: user.id,
    // The shape multer produces, so the upload path is the one already tested:
    // it sanitises the name, generates the stored name, and checks access.
    file: {
      buffer,
      originalname: name,
      mimetype: 'text/plain',
      size: buffer.byteLength,
    },
  })

  return created.id
}
