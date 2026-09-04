import * as Y from 'yjs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { clearDatabase, startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { MongoPersistence } from '../src/collab/persistence.js'
import { DocUpdate } from '../src/models/DocUpdate.js'
import { Checkpoint } from '../src/models/Checkpoint.js'
import {
  backfillCheckpoints,
  CHECKPOINT_EVERY,
  CHECKPOINT_SETTLE,
  checkpointTarget,
  ensureCheckpoint,
  snapshotJsonAt,
  stateAt,
} from '../src/services/replay.service.js'

/**
 * Checkpoints let a replay read start most of the way through the log instead
 * of folding it from the beginning every time.
 *
 * That is only worth having if a checkpointed read is *identical* to the fold
 * it replaces. Most of what follows compares the two directly rather than
 * trusting that it must be so.
 */

const ROOM = 'checkpoint-room'

function recordEdits(steps) {
  const doc = new Y.Doc()
  const updates = []
  doc.on('update', (update) => updates.push(Buffer.from(update)))
  steps.forEach((step) => step(doc))
  doc.destroy()
  return updates
}

/** A log of `count` edits, shaped like a session: mostly typing, some shapes. */
function session(count) {
  return recordEdits(
    Array.from({ length: count }, (_, i) => (doc) => {
      if (i % 10 === 9) {
        doc.getArray('shapes').push([{ id: 's' + i, type: 'rect', x: i, y: i, width: 5, height: 5 }])
      } else {
        const text = doc.getText('code')
        text.insert(text.length, String.fromCharCode(97 + (i % 26)))
      }
    })
  )
}

async function seedLog(updates, roomId = ROOM, startAt = 1) {
  for (let i = 0; i < updates.length; i += 1) {
    await DocUpdate.create({
      roomId,
      seq: startAt + i,
      update: updates[i],
      actor: 'user-' + (i % 2),
      size: updates[i].byteLength,
    })
  }
}

/** The same read with every checkpoint removed, for comparison. */
async function withoutCheckpoints(roomId, seq) {
  const saved = await Checkpoint.find({ roomId }).lean()
  await Checkpoint.deleteMany({ roomId })
  try {
    return await stateAt(roomId, seq)
  } finally {
    await Checkpoint.insertMany(saved)
  }
}

beforeAll(async () => {
  await startMemoryMongo()
  // The unique (roomId, seq) index is what keeps two checkpoints from being
  // written for the same point, so the tests should run against it.
  await mongoose.connection.syncIndexes()
}, 120000)
afterAll(stopMemoryMongo)
beforeEach(clearDatabase)

describe('checkpointTarget', () => {
  it('picks a point a little behind each interval boundary', () => {
    expect(checkpointTarget(CHECKPOINT_EVERY)).toBe(CHECKPOINT_EVERY - CHECKPOINT_SETTLE)
    expect(checkpointTarget(CHECKPOINT_EVERY * 3)).toBe(CHECKPOINT_EVERY * 3 - CHECKPOINT_SETTLE)
  })

  it('is silent between boundaries, so the write path pays nothing per update', () => {
    expect(checkpointTarget(CHECKPOINT_EVERY + 1)).toBe(0)
    expect(checkpointTarget(CHECKPOINT_EVERY - 1)).toBe(0)
    expect(checkpointTarget(1)).toBe(0)
  })

  it('refuses nonsense rather than checkpointing something meaningless', () => {
    expect(checkpointTarget(0)).toBe(0)
    expect(checkpointTarget(-CHECKPOINT_EVERY)).toBe(0)
    expect(checkpointTarget(undefined)).toBe(0)
    expect(checkpointTarget(1.5)).toBe(0)
  })
})

describe('a checkpointed read is the read it replaces', () => {
  /** The whole feature rests on this one. */
  it('returns byte-identical state at every position, checkpointed or not', async () => {
    await seedLog(session(CHECKPOINT_EVERY * 3))
    await backfillCheckpoints(ROOM)
    expect(await Checkpoint.countDocuments({ roomId: ROOM })).toBeGreaterThan(0)

    const positions = [
      0,
      1,
      CHECKPOINT_EVERY - CHECKPOINT_SETTLE - 1,
      CHECKPOINT_EVERY - CHECKPOINT_SETTLE,
      CHECKPOINT_EVERY - CHECKPOINT_SETTLE + 1,
      CHECKPOINT_EVERY,
      CHECKPOINT_EVERY * 2,
      CHECKPOINT_EVERY * 3,
      CHECKPOINT_EVERY * 9, // past the end of the log
    ]

    for (const seq of positions) {
      const fast = await stateAt(ROOM, seq)
      const plain = await withoutCheckpoints(ROOM, seq)
      expect(fast.state.equals(plain.state), 'state differs at seq ' + seq).toBe(true)
    }
  })

  it('reads the same document contents, not merely the same bytes', async () => {
    await seedLog(session(CHECKPOINT_EVERY * 2))
    const before = await snapshotJsonAt(ROOM, CHECKPOINT_EVERY * 2)

    await backfillCheckpoints(ROOM)
    const after = await snapshotJsonAt(ROOM, CHECKPOINT_EVERY * 2)

    expect(after.code).toBe(before.code)
    expect(after.shapes).toEqual(before.shapes)
    expect(after.code.length).toBeGreaterThan(0)
    expect(after.shapes.length).toBeGreaterThan(0)
  })

  it('does the work it claims to skip, and says where it started', async () => {
    await seedLog(session(CHECKPOINT_EVERY * 2))
    await backfillCheckpoints(ROOM)

    const target = CHECKPOINT_EVERY * 2
    const fast = await stateAt(ROOM, target)
    const plain = await withoutCheckpoints(ROOM, target)

    expect(plain.from).toBe(0)
    expect(plain.applied).toBe(target)

    expect(fast.from).toBeGreaterThan(0)
    expect(fast.applied).toBeLessThan(plain.applied)
    // What it folded plus what the checkpoint stood for is the whole log.
    expect(fast.from + fast.applied).toBe(target)
  })

  it('still answers an empty document for seq 0', async () => {
    await seedLog(session(CHECKPOINT_EVERY * 2))
    await backfillCheckpoints(ROOM)

    const { code, shapes } = await snapshotJsonAt(ROOM, 0)
    expect(code).toBe('')
    expect(shapes).toEqual([])
    expect((await stateAt(ROOM, 0)).from).toBe(0)
  })
})

describe('a checkpoint that no longer matches the log', () => {
  /**
   * Sequence numbers are handed out before the insert that uses them, so an
   * entry numbered below a checkpoint can in principle land after it was
   * built. The checkpoint would then be missing an edit. It must be refused,
   * not served.
   */
  it('is refused, and the read falls back to the truth', async () => {
    const updates = session(CHECKPOINT_EVERY * 2)
    // Leave a hole at seq 5 that a straggler will fill later.
    await seedLog(updates.slice(0, 4), ROOM, 1)
    await seedLog(updates.slice(5), ROOM, 6)
    await backfillCheckpoints(ROOM)

    const checkpoint = await Checkpoint.findOne({ roomId: ROOM }).sort({ seq: 1 }).lean()
    expect(checkpoint).toBeTruthy()

    // The straggler arrives, below a checkpoint that has already been built.
    await DocUpdate.create({ roomId: ROOM, seq: 5, update: updates[4], size: updates[4].byteLength })

    const read = await stateAt(ROOM, CHECKPOINT_EVERY * 2)
    expect(read.from, 'a stale checkpoint must not be used').toBe(0)

    // And the answer is the real fold, straggler included.
    const plain = await withoutCheckpoints(ROOM, CHECKPOINT_EVERY * 2)
    expect(read.state.equals(plain.state)).toBe(true)
  })

  it('is rebuilt when the write path next passes it', async () => {
    const updates = session(CHECKPOINT_EVERY * 2)
    await seedLog(updates.slice(0, 4), ROOM, 1)
    await seedLog(updates.slice(5), ROOM, 6)
    await backfillCheckpoints(ROOM)

    await DocUpdate.create({ roomId: ROOM, seq: 5, update: updates[4], size: updates[4].byteLength })

    const target = checkpointTarget(CHECKPOINT_EVERY)
    await ensureCheckpoint(ROOM, target)

    // A read that lands on the repaired one uses it again.
    const at = CHECKPOINT_EVERY + CHECKPOINT_SETTLE
    const repaired = await stateAt(ROOM, at)
    expect(repaired.from).toBe(target)

    const plain = await withoutCheckpoints(ROOM, at)
    expect(repaired.state.equals(plain.state)).toBe(true)
  })

  /**
   * A late entry invalidates every checkpoint above it, and a read only ever
   * consults the newest one at or before the position it wants. So repairing
   * a single checkpoint speeds up the reads that land on it and leaves the
   * ones above it folding from the beginning — correct, just slow — until
   * they are rebuilt too.
   */
  it('leaves later checkpoints stale until they are rebuilt in turn', async () => {
    const updates = session(CHECKPOINT_EVERY * 3)
    await seedLog(updates.slice(0, 4), ROOM, 1)
    await seedLog(updates.slice(5), ROOM, 6)
    await backfillCheckpoints(ROOM)

    await DocUpdate.create({ roomId: ROOM, seq: 5, update: updates[4], size: updates[4].byteLength })

    await ensureCheckpoint(ROOM, checkpointTarget(CHECKPOINT_EVERY))
    // The read at the top still finds a stale checkpoint and refuses it.
    expect((await stateAt(ROOM, CHECKPOINT_EVERY * 3)).from).toBe(0)

    // Backfilling walks every boundary, so it is the way back to healthy.
    await backfillCheckpoints(ROOM)
    const healed = await stateAt(ROOM, CHECKPOINT_EVERY * 3)
    expect(healed.from).toBeGreaterThan(0)

    const plain = await withoutCheckpoints(ROOM, CHECKPOINT_EVERY * 3)
    expect(healed.state.equals(plain.state)).toBe(true)
  })
})

describe('ensureCheckpoint', () => {
  it('does nothing twice', async () => {
    await seedLog(session(CHECKPOINT_EVERY))
    const target = checkpointTarget(CHECKPOINT_EVERY)

    expect(await ensureCheckpoint(ROOM, target)).toBeTruthy()
    expect(await ensureCheckpoint(ROOM, target)).toBeNull()
    expect(await Checkpoint.countDocuments({ roomId: ROOM, seq: target })).toBe(1)
  })

  it('records nothing for a point with no history behind it', async () => {
    expect(await ensureCheckpoint('empty-room', 50)).toBeNull()
    expect(await Checkpoint.countDocuments({ roomId: 'empty-room' })).toBe(0)
  })

  it('refuses a meaningless target instead of storing an empty document', async () => {
    await seedLog(session(CHECKPOINT_EVERY))
    expect(await ensureCheckpoint(ROOM, 0)).toBeNull()
    expect(await ensureCheckpoint(ROOM, -1)).toBeNull()
    expect(await Checkpoint.countDocuments({ roomId: ROOM })).toBe(0)
  })
})

describe('backfillCheckpoints', () => {
  it('lays down the same points the write path would have', async () => {
    await seedLog(session(CHECKPOINT_EVERY * 3))
    const { built } = await backfillCheckpoints(ROOM)
    expect(built).toBe(3)

    const seqs = (await Checkpoint.find({ roomId: ROOM }).sort({ seq: 1 }).lean()).map((c) => c.seq)
    expect(seqs).toEqual([
      checkpointTarget(CHECKPOINT_EVERY),
      checkpointTarget(CHECKPOINT_EVERY * 2),
      checkpointTarget(CHECKPOINT_EVERY * 3),
    ])
  })

  it('adds nothing on a second pass', async () => {
    await seedLog(session(CHECKPOINT_EVERY * 2))
    await backfillCheckpoints(ROOM)
    expect((await backfillCheckpoints(ROOM)).built).toBe(0)
  })

  it('leaves a log too short to need one alone', async () => {
    await seedLog(session(CHECKPOINT_EVERY - CHECKPOINT_SETTLE - 1))
    expect((await backfillCheckpoints(ROOM)).built).toBe(0)
  })

  it('is empty for a room with no log', async () => {
    expect(await backfillCheckpoints('no-such-room')).toEqual({ built: 0, bytes: 0 })
  })
})

describe('rooms stay separate', () => {
  it('never reads another room’s checkpoint', async () => {
    await seedLog(
      recordEdits([(doc) => doc.getText('code').insert(0, 'mine')].concat(
        Array.from({ length: CHECKPOINT_EVERY }, () => (doc) => {
          const text = doc.getText('code')
          text.insert(text.length, 'x')
        })
      )),
      ROOM
    )
    await seedLog(
      recordEdits([(doc) => doc.getText('code').insert(0, 'theirs')].concat(
        Array.from({ length: CHECKPOINT_EVERY }, () => (doc) => {
          const text = doc.getText('code')
          text.insert(text.length, 'y')
        })
      )),
      'other-room'
    )

    await backfillCheckpoints(ROOM)
    await backfillCheckpoints('other-room')

    expect((await snapshotJsonAt(ROOM, 9999)).code).toMatch(/^mine/)
    expect((await snapshotJsonAt('other-room', 9999)).code).toMatch(/^theirs/)
  })
})

/**
 * The service can be told to write a checkpoint; this is about whether
 * anything ever tells it to. The existing persistence tests drive onChange
 * with single bytes, which are not Yjs updates and could never be folded, so
 * this is the only place the real write path meets a real document.
 */
describe('the collaboration write path', () => {
  it('lays down a checkpoint once the log passes an interval', async () => {
    const room = 'write-path-room'
    const store = new MongoPersistence()

    const doc = new Y.Doc()
    const updates = []
    doc.on('update', (update) => updates.push(update))
    for (let i = 0; i < CHECKPOINT_EVERY; i += 1) doc.getText('code').insert(i, 'x')
    doc.destroy()
    expect(updates).toHaveLength(CHECKPOINT_EVERY)

    for (const update of updates) {
      await store.onChange({ documentName: room, update, context: {} })
    }

    const target = checkpointTarget(CHECKPOINT_EVERY)
    const written = await Checkpoint.findOne({ roomId: room, seq: target }).lean()

    expect(written, 'nothing wrote a checkpoint').toBeTruthy()
    expect(written.covers).toBe(target)

    // And it is the state it claims to be.
    const fast = await stateAt(room, CHECKPOINT_EVERY)
    const plain = await withoutCheckpoints(room, CHECKPOINT_EVERY)
    expect(fast.from).toBe(target)
    expect(fast.state.equals(plain.state)).toBe(true)
  }, 120000)

  it('writes exactly one, not one per update past the boundary', async () => {
    const room = 'write-path-once'
    const store = new MongoPersistence()

    const doc = new Y.Doc()
    const updates = []
    doc.on('update', (update) => updates.push(update))
    for (let i = 0; i < CHECKPOINT_EVERY + 10; i += 1) doc.getText('code').insert(i, 'y')
    doc.destroy()

    for (const update of updates) {
      await store.onChange({ documentName: room, update, context: {} })
    }

    expect(await Checkpoint.countDocuments({ roomId: room })).toBe(1)
  }, 120000)
})
