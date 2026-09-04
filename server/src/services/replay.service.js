import * as Y from 'yjs'
import { DocUpdate } from '../models/DocUpdate.js'
import { Checkpoint } from '../models/Checkpoint.js'
import { toUint8 } from '../utils/binary.js'
import { badRequest } from '../errors.js'
import { logger } from '../config/logger.js'

const MAX_TIMELINE = 500

/**
 * How often a checkpoint is laid down, in log entries.
 *
 * Chosen by measuring rather than by taste — `scripts/replay-bench.js` prints
 * both sides. Over a 3,000 entry log, playing back consecutive frames costs
 * 160ms each with no checkpoints and 15.7ms with these, and the cost stops
 * growing with the room's age.
 *
 * The interval is a trade against storage, and a sharper one than it looks.
 * Each checkpoint is a full copy of the document, and the document grows as
 * the log does, so total checkpoint bytes go as O(n² / interval) against a log
 * that grows as O(n). At 100 the checkpoints came to 193 KB against a 65 KB
 * log — three times the thing they summarise. At 250 they come to 79 KB
 * against 60 KB, for a read that is still ten times faster. Thinning old
 * checkpoints is what makes a much smaller interval affordable; see the
 * update-log note in the README.
 */
export const CHECKPOINT_EVERY = 250

/**
 * How far behind the newest entry a checkpoint is built.
 *
 * Sequence numbers are allocated before the insert that uses them, so two
 * updates can be numbered in one order and land in the other. Building a
 * little way back means the entries below the checkpoint have settled. It is
 * belt and braces — `covers` catches a straggler anyway — but it keeps that
 * path from being exercised in normal operation.
 */
export const CHECKPOINT_SETTLE = 20

/**
 * Metadata for the replay scrubber — never the payloads themselves.
 *
 * `from` is an exclusive lower bound on `seq`, so a caller can page through a
 * log longer than one response may carry. A room passes 500 updates within a
 * few minutes of typing, and a scrubber that could only ever see the first
 * page would end somewhere in the room's distant past while claiming to be
 * its history. Paging is safe here in a way it rarely is: the log is
 * append-only, so a page already read can never change underneath the reader.
 */
export async function listTimeline(roomId, { limit = MAX_TIMELINE, from = 0 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || MAX_TIMELINE, 1), MAX_TIMELINE)

  const after = Number(from)
  const query = { roomId }
  if (Number.isFinite(after) && after > 0) query.seq = { $gt: after }

  const entries = await DocUpdate.find(query)
    .select({ seq: 1, actor: 1, size: 1, createdAt: 1 })
    .sort({ seq: 1 })
    .limit(capped)
    .lean()

  return entries.map((entry) => ({
    seq: entry.seq,
    actor: entry.actor,
    size: entry.size,
    at: entry.createdAt,
  }))
}

/** The sequence number worth checkpointing once `latest` has been written. */
export function checkpointTarget(latest) {
  const seq = Number(latest)
  if (!Number.isInteger(seq) || seq % CHECKPOINT_EVERY !== 0) return 0
  const target = seq - CHECKPOINT_SETTLE
  return target > 0 ? target : 0
}

/**
 * The newest checkpoint at or before `seq` that still tells the truth.
 *
 * A checkpoint is a fold of the entries below it, and the count of those
 * entries is stored alongside it. If the log has since grown underneath — an
 * entry numbered below this point that landed after it was built — the fold no
 * longer matches the log and the checkpoint is refused. Refusing costs a full
 * fold, which is merely slow; using it would silently drop somebody's edit.
 */
async function usableCheckpoint(roomId, seq) {
  const checkpoint = await Checkpoint.findOne({ roomId, seq: { $lte: seq } })
    .sort({ seq: -1 })
    .lean()

  if (!checkpoint) return null

  const present = await DocUpdate.countDocuments({ roomId, seq: { $lte: checkpoint.seq } })
  if (present === checkpoint.covers) return checkpoint

  logger.warn(
    { room: roomId, seq: checkpoint.seq, covers: checkpoint.covers, present },
    'replay checkpoint no longer matches the log; folding from the beginning'
  )
  return null
}

/**
 * The document exactly as it stood at `seq`.
 *
 * Yjs updates are commutative, so this is the fold of every entry up to that
 * point — and folding is all it ever was, once, per frame, from zero. A room
 * accumulates an entry per keystroke, so that cost grows with the room's age
 * and a scrubber near the end of a long history pays it on every step.
 * Checkpoints let the fold start most of the way there instead.
 *
 * Answers `from`: the checkpoint it started from, or 0 for a fold of the whole
 * log. `applied` counts only the entries folded on top, which is the work this
 * call actually did.
 */
export async function stateAt(roomId, seq) {
  const target = Number(seq)
  if (!Number.isInteger(target) || target < 0) {
    throw badRequest('seq must be a non-negative integer', 'bad_seq')
  }

  const checkpoint = await usableCheckpoint(roomId, target)
  const from = checkpoint?.seq ?? 0

  const cursor = DocUpdate.find({ roomId, seq: { $gt: from, $lte: target } })
    .sort({ seq: 1 })
    .cursor()

  const doc = new Y.Doc()
  let applied = 0

  try {
    if (checkpoint) Y.applyUpdate(doc, toUint8(checkpoint.state))
    for await (const entry of cursor) {
      Y.applyUpdate(doc, toUint8(entry.update))
      applied += 1
    }
    return { state: Buffer.from(Y.encodeStateAsUpdate(doc)), applied, from }
  } finally {
    doc.destroy()
  }
}

/**
 * Records the state at `seq` so later reads can start from it.
 *
 * Built by folding the log rather than by copying a live document. A document
 * in memory only equals the fold of the log when nothing has gone wrong — a
 * failed insert, a second process, a sequence number allocated and never
 * used — and a checkpoint that disagrees with the log is a replay that quietly
 * shows the wrong thing. Folding the log cannot disagree with the log.
 *
 * Idempotent, and self-healing: an existing checkpoint whose entry count no
 * longer matches is rebuilt rather than left to be refused by every read.
 */
export async function ensureCheckpoint(roomId, seq) {
  const target = Number(seq)
  if (!Number.isInteger(target) || target <= 0) return null

  const existing = await Checkpoint.findOne({ roomId, seq: target })
    .select({ seq: 1, covers: 1 })
    .lean()

  if (existing) {
    const present = await DocUpdate.countDocuments({ roomId, seq: { $lte: target } })
    if (present === existing.covers) return null
  }

  const { state } = await stateAt(roomId, target)
  const covers = await DocUpdate.countDocuments({ roomId, seq: { $lte: target } })

  // Nothing to stand in for: no entries at or below this point.
  if (covers === 0) return null

  await Checkpoint.updateOne(
    { roomId, seq: target },
    { $set: { state, covers, size: state.byteLength } },
    { upsert: true }
  )

  return { roomId, seq: target, covers, size: state.byteLength }
}

/**
 * Lays down every checkpoint a room should already have.
 *
 * A room being edited gets its checkpoints as it goes. This is for the rooms
 * that already had a long log before there were any — without it their replay
 * stays as slow as it ever was, because the write path only ever records the
 * one point it has just passed.
 *
 * Deliberately the same targets the write path picks, so a backfilled room and
 * a live one end up with the same checkpoints rather than two interleaved sets
 * of nearly identical document copies.
 */
export async function backfillCheckpoints(roomId) {
  const last = await DocUpdate.findOne({ roomId }).sort({ seq: -1 }).select({ seq: 1 }).lean()
  if (!last) return { built: 0, bytes: 0 }

  let built = 0
  let bytes = 0

  for (let boundary = CHECKPOINT_EVERY; boundary <= last.seq; boundary += CHECKPOINT_EVERY) {
    const target = checkpointTarget(boundary)
    if (!target) continue
    // Each one folds from the previous, so the whole walk costs one pass over
    // the log rather than one pass per checkpoint.
    const made = await ensureCheckpoint(roomId, target)
    if (made) {
      built += 1
      bytes += made.size
    }
  }

  return { built, bytes }
}

/** Convenience for tests and tooling: the readable contents at a point in time. */
export async function snapshotJsonAt(roomId, seq) {
  const { state } = await stateAt(roomId, seq)
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, toUint8(state))
    return {
      shapes: doc.getArray('shapes').toJSON(),
      code: doc.getText('code').toString(),
    }
  } finally {
    doc.destroy()
  }
}
