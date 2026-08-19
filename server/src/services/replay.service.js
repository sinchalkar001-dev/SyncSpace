import * as Y from 'yjs'
import { DocUpdate } from '../models/DocUpdate.js'
import { toUint8 } from '../utils/binary.js'
import { badRequest } from '../errors.js'

const MAX_TIMELINE = 500

/** Metadata for the replay scrubber — never the payloads themselves. */
export async function listTimeline(roomId, { limit = MAX_TIMELINE } = {}) {
  const capped = Math.min(Math.max(Number(limit) || MAX_TIMELINE, 1), MAX_TIMELINE)

  const entries = await DocUpdate.find({ roomId })
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

/**
 * Folds the log from the beginning up to `seq` into a fresh document.
 * Yjs updates are commutative, so the result is the exact state at that point.
 */
export async function stateAt(roomId, seq) {
  const target = Number(seq)
  if (!Number.isInteger(target) || target < 0) {
    throw badRequest('seq must be a non-negative integer', 'bad_seq')
  }

  const cursor = DocUpdate.find({ roomId, seq: { $lte: target } })
    .sort({ seq: 1 })
    .cursor()

  const doc = new Y.Doc()
  let applied = 0

  try {
    for await (const entry of cursor) {
      Y.applyUpdate(doc, toUint8(entry.update))
      applied += 1
    }
    return { state: Buffer.from(Y.encodeStateAsUpdate(doc)), applied }
  } finally {
    doc.destroy()
  }
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
