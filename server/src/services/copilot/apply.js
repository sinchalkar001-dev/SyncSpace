import { File } from '../../models/File.js'
import { logger } from '../../config/logger.js'
import { badRequest, conflict, forbidden } from '../../errors.js'
import { CAPABILITIES, can } from '../../permissions.js'
import { deleteFile, uploadFile } from '../file.service.js'
import { roomFileNameFor } from '../generation.service.js'
import { getIo } from '../../realtime/registry.js'
import { actionById } from './actions.js'
import { getCopilotRun } from './run.js'

/**
 * Turning an answer into a change, which is the only part of this feature that
 * touches the room.
 *
 * Two rules hold everywhere below.
 *
 * Nothing is applied that was not named. `accept` lists what somebody ticked;
 * everything else in the change set is recorded as rejected rather than left
 * undecided, because a proposal with no decision against it cannot be told
 * apart from one nobody has looked at yet. An empty list is a real answer —
 * "none of this" — and is recorded as one.
 *
 * Nothing is applied that would overwrite something the reviewer did not see.
 * For files that means the change set was reconciled against the room when it
 * was produced, so a file landing on an existing name arrived carrying the
 * contents it would replace. For the code buffer it means the buffer must
 * still read exactly as the model was shown it; if somebody typed in the
 * meantime the patch is refused as stale, and refusing is the entire value of
 * the feature. A copilot that wins races against the people using it is worse
 * than no copilot.
 */

/** The capability applying this kind of answer needs, beyond asking for one. */
function assertMayApply(room, userId, kind) {
  const capability =
    kind === 'code' ? CAPABILITIES.CODE_EDIT : CAPABILITIES.FILES_UPLOAD

  if (!can(room, userId, capability)) {
    throw forbidden(
      kind === 'code'
        ? 'Your role in this room does not include editing the code'
        : 'Your role in this room does not include adding files',
      'apply_forbidden'
    )
  }
}

/**
 * Applies the files somebody accepted, and records the rest as rejected.
 *
 * Each file is applied on its own and a failure is recorded against that file
 * rather than thrown: half a change set applied with a clear note on the two
 * that did not is a better place to be than a rollback of work somebody has
 * just reviewed, and each of these writes is independent so there is nothing
 * to be consistent with.
 */
export async function applyCopilotFiles({ room, runId, user, accept = [] }) {
  const run = await getCopilotRun(room.roomId, runId)

  const action = actionById(run.actionId)
  if (action?.apply?.kind !== 'files' || !run.files.length) {
    throw badRequest('That copilot answer did not propose any files', 'nothing_to_apply')
  }

  assertMayApply(room, user.id, 'files')

  const wanted = new Set(accept.map(String))
  const unknown = [...wanted].filter((id) => !run.files.some((file) => String(file._id) === id))
  if (unknown.length > 0) {
    throw badRequest('That answer has no file ' + unknown[0], 'unknown_file')
  }

  let applied = 0
  let rejected = 0
  let failed = 0

  for (const file of run.files) {
    // Already decided; applying twice would write a second copy.
    if (file.status !== 'proposed') continue

    if (!wanted.has(String(file._id))) {
      file.status = 'rejected'
      rejected += 1
      continue
    }

    try {
      file.appliedFileId = await applyOneFile({ roomId: room.roomId, user, file })
      file.status = 'applied'
      file.appliedAt = new Date()
      file.error = null
      applied += 1
    } catch (error) {
      // Left `proposed` deliberately: it has not been turned down, and the
      // person should be able to fix the cause and press apply again.
      file.error = String(error?.message ?? 'Could not apply this file').slice(0, 300)
      failed += 1
      logger.warn({ err: error, room: room.roomId, path: file.path }, 'could not apply a copilot file')
    }
  }

  await run.save()

  if (applied > 0) {
    getIo()?.to(room.roomId).emit('copilot:applied', {
      roomId: room.roomId,
      runId: String(run._id),
      kind: 'files',
      applied,
      by: { id: String(user.id), name: user.name ?? null },
    })
  }

  return { run: run.toPublic(), applied, rejected, failed }
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

/**
 * Records what happened to a proposed buffer patch.
 *
 * The server does not write the patch, and that is deliberate rather than a
 * gap. The buffer is a Yjs document: the client applies the change inside one
 * transaction, tagged with its own origin so undo works and so every other
 * person in the room receives it as an ordinary edit by the person who
 * accepted it. A server-side write would arrive with no origin, would not
 * group for undo, and — in a room nobody currently has open — would have to
 * rebuild the document to write into it, which is exactly how an update log
 * stops being a faithful history.
 *
 * So the client applies it and then says what happened, and this records the
 * outcome. `stale` is reported by the client when the buffer no longer matched
 * what the model was shown, but the check does not rest on the client's
 * honesty alone: the buffer is a shared document, so a client that applied
 * over somebody's edit would have produced a visible change everyone can see
 * and undo. What this record is for is the history — what was proposed, by
 * whom, and whether it was taken.
 */
export async function recordPatchOutcome({ room, runId, user, outcome }) {
  const run = await getCopilotRun(room.roomId, runId)

  if (!run.patch) {
    throw badRequest('That copilot answer did not propose a change to the code', 'nothing_to_apply')
  }

  if (run.patch.status !== 'proposed') {
    throw conflict('That change has already been ' + run.patch.status, 'already_decided')
  }

  if (outcome === 'applied') assertMayApply(room, user.id, 'code')

  run.patch.status = outcome
  run.patch.appliedAt = outcome === 'applied' ? new Date() : null
  await run.save()

  if (outcome === 'applied') {
    getIo()?.to(room.roomId).emit('copilot:applied', {
      roomId: room.roomId,
      runId: String(run._id),
      kind: 'code',
      applied: 1,
      by: { id: String(user.id), name: user.name ?? null },
    })
  }

  return { run: run.toPublic() }
}
