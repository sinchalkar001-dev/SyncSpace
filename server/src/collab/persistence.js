import * as Y from 'yjs'
import { Snapshot } from '../models/Snapshot.js'
import { DocUpdate } from '../models/DocUpdate.js'
import { Room } from '../models/Room.js'
import { ensureRoom } from '../services/room.service.js'
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
 * extension.
 */
export class MongoPersistence {
  constructor() {
    this.sequences = new Map()
  }

  nextSeq(roomId) {
    const next = this.sequences.get(roomId) ?? 1
    this.sequences.set(roomId, next + 1)
    return next
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

  async onChange({ documentName, update, context }) {
    if (!env.PERSIST_UPDATE_LOG) return

    await DocUpdate.create({
      roomId: documentName,
      seq: this.nextSeq(documentName),
      update: Buffer.from(update),
      actor: context?.user?.id ?? null,
      size: update.byteLength,
    })
  }

  async onStoreDocument({ documentName, document }) {
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

  async onDisconnect({ documentName, clientsCount }) {
    if (clientsCount === 0) this.sequences.delete(documentName)
  }
}
