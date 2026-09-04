import * as Y from 'yjs'
import { Snapshot } from '../models/Snapshot.js'
import { DocUpdate } from '../models/DocUpdate.js'
import { Room } from '../models/Room.js'
import { ensureRoom } from '../services/room.service.js'
import { checkpointTarget, ensureCheckpoint } from '../services/replay.service.js'
import { toUint8 } from '../utils/binary.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

/**
 * Hocuspocus extension backing documents with MongoDB.
 *
 * Two tiers: a debounced full snapshot for fast loads, and an append-only
 * update log that powers replay and covers anything written since the last
 * snapshot. Loading applies the snapshot first, then the log tail.
 *
 * The sequence counter is per-process. That is correct for a single node;
 * going multi-node means moving it to Redis alongside the Hocuspocus Redis
 * extension. Until then the unique index on (roomId, seq) is the authority:
 * a collision is caught and the counter re-derived from the log.
 */
const DUPLICATE_KEY = 11000
const SEQ_ATTEMPTS = 5

export class MongoPersistence {
  constructor() {
    this.sequences = new Map()
  }

  nextSeq(roomId) {
    const next = this.sequences.get(roomId) ?? 1
    this.sequences.set(roomId, next + 1)
    return next
  }

  /** Re-reads the high-water mark, for when the in-memory counter is behind. */
  async syncSeq(roomId) {
    const last = await DocUpdate.findOne({ roomId }).sort({ seq: -1 }).select({ seq: 1 }).lean()
    this.sequences.set(roomId, (last?.seq ?? 0) + 1)
  }

  async onLoadDocument({ documentName, document }) {
    await ensureRoom(documentName)

    const snapshot = await Snapshot.findOne({ roomId: documentName }).lean()
    if (snapshot?.state) {
      Y.applyUpdate(document, toUint8(snapshot.state))
    }

    const from = snapshot?.seq ?? 0
    const tail = await DocUpdate.find({ roomId: documentName, seq: { $gt: from } })
      .sort({ seq: 1 })
      .lean()

    tail.forEach((entry) => Y.applyUpdate(document, toUint8(entry.update)))

    const last = await DocUpdate.findOne({ roomId: documentName })
      .sort({ seq: -1 })
      .select({ seq: 1 })
      .lean()

    this.sequences.set(documentName, (last?.seq ?? 0) + 1)

    logger.debug(
      { room: documentName, snapshot: Boolean(snapshot), replayed: tail.length },
      'document loaded'
    )
    // Mutating `document` is enough; returning it would re-apply its own state.
  }

  async appendUpdate({ documentName, update, context }) {
    for (let attempt = 1; attempt <= SEQ_ATTEMPTS; attempt += 1) {
      try {
        return await DocUpdate.create({
          roomId: documentName,
          seq: this.nextSeq(documentName),
          update: Buffer.from(update),
          actor: context?.user?.id ?? null,
          size: update.byteLength,
        })
      } catch (error) {
        if (error?.code !== DUPLICATE_KEY) throw error
        // The slot was taken — by a reconnect that reset the counter, or by a
        // second process. Take the log's word for where the end is and retry.
        await this.syncSeq(documentName)
      }
    }

    throw new Error('could not allocate a sequence number for ' + documentName)
  }

  async onChange(payload) {
    if (!env.PERSIST_UPDATE_LOG) return

    let entry
    try {
      entry = await this.appendUpdate(payload)
    } catch (error) {
      // Hocuspocus rethrows whatever this hook rejects with, which Node turns
      // into an unhandled rejection and a dead process — one failed insert
      // would disconnect every room on the server. The log is a convenience
      // (the snapshot still carries the document), so this is logged and the
      // session carries on.
      logger.error({ err: error, room: payload.documentName }, 'update log append failed')
      return
    }

    // Every hundredth entry, record where the room stood a little way back, so
    // a replay read starts from there instead of folding the whole log. The
    // fold this costs covers one interval and happens once per interval, which
    // is a fraction of a millisecond amortised across the edits themselves.
    const target = checkpointTarget(entry?.seq)
    if (!target) return

    try {
      await ensureCheckpoint(payload.documentName, target)
    } catch (error) {
      // Its own catch, deliberately: a checkpoint is an optimisation, and
      // failing to write one must neither take the session down nor be
      // mistaken in the log for failing to record somebody's edit.
      logger.error(
        { err: error, room: payload.documentName, seq: target },
        'replay checkpoint failed'
      )
    }
  }

  async onStoreDocument(payload) {
    // Same reasoning as onChange: a storage failure must not take the process
    // with it. The next debounced store will try again.
    try {
      await this.storeDocument(payload)
    } catch (error) {
      logger.error({ err: error, room: payload.documentName }, 'snapshot store failed')
    }
  }

  async storeDocument({ documentName, document }) {
    const state = Buffer.from(Y.encodeStateAsUpdate(document))
    const seq = (this.sequences.get(documentName) ?? 1) - 1

    await Snapshot.findOneAndUpdate(
      { roomId: documentName },
      { $set: { state, seq, size: state.byteLength } },
      { upsert: true }
    )
    await Room.updateOne({ roomId: documentName }, { $set: { lastActivityAt: new Date() } })

    logger.debug({ room: documentName, bytes: state.byteLength, seq }, 'snapshot stored')
  }

  /**
   * Counters are dropped when the document leaves memory, not when the last
   * client disconnects: Hocuspocus keeps writing an emptied room's pending
   * updates, and a counter cleared underneath those restarted numbering at 1
   * and collided with rows already in the log.
   */
  async afterUnloadDocument({ documentName }) {
    this.sequences.delete(documentName)
  }
}
