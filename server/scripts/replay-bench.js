/**
 * What one replay frame costs.
 *
 * The scrubber asks for a document state at a sequence number, and every
 * position it lands on is a fresh fold of the log. This seeds a room shaped
 * like a real session and times frames across it, so a change to how that fold
 * is computed can be checked rather than assumed.
 *
 *   node scripts/replay-bench.js [updates]
 *
 * Runs against a throwaway in-memory MongoDB; nothing is written to a real one.
 */
import mongoose from 'mongoose'
import * as Y from 'yjs'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { DocUpdate } from '../src/models/DocUpdate.js'
import { Checkpoint } from '../src/models/Checkpoint.js'
import { backfillCheckpoints, stateAt } from '../src/services/replay.service.js'

const TOTAL = Number(process.argv[2] || 3000)
const ROOM = 'bench-room'
const PLAYBACK_RUN = 40

const out = (line = '') => process.stdout.write(line + '\n')

const mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } })
await mongoose.connect(mongod.getUri('syncspace-bench'))

/**
 * A log shaped like a session someone actually had: mostly single characters
 * arriving in the buffer, with a shape landing on the board now and then.
 */
function record(count) {
  const doc = new Y.Doc()
  const updates = []
  doc.on('update', (update) => updates.push(Buffer.from(update)))

  for (let i = 0; i < count; i += 1) {
    if (i % 20 === 19) {
      doc
        .getArray('shapes')
        .push([{ id: 's' + i, type: 'rect', x: i % 900, y: i % 500, width: 40, height: 30 }])
    } else {
      const text = doc.getText('code')
      text.insert(text.length, String.fromCharCode(97 + (i % 26)))
    }
  }

  doc.destroy()
  return updates
}

out(`seeding ${TOTAL} updates`)
const updates = record(TOTAL)

const rows = updates.map((update, i) => ({
  roomId: ROOM,
  seq: i + 1,
  update,
  actor: 'bench-user',
  size: update.byteLength,
  createdAt: new Date(),
  updatedAt: new Date(),
}))

// Through the native driver: the model blocks bulk writes by design.
for (let i = 0; i < rows.length; i += 500) {
  await DocUpdate.collection.insertMany(rows.slice(i, i + 500))
}
out(`seeded ${await DocUpdate.countDocuments({ roomId: ROOM })} rows`)
out()

const time = async (seq) => {
  const started = process.hrtime.bigint()
  const { applied, from } = await stateAt(ROOM, seq)
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, applied, from: from ?? 0 }
}

/**
 * Frames at five points across the log, then a stretch of consecutive ones.
 * The stretch is the workload that matters: playback asks for every position
 * in turn, so a per-frame cost that grows with the room is felt on every step.
 */
async function measure(label) {
  await time(1) // warm the connection so the first row is not paying for it

  out(label)
  out('  position     from   folded       ms')
  let scattered = 0

  for (const fraction of [0.01, 0.25, 0.5, 0.75, 1]) {
    const seq = Math.max(1, Math.round(TOTAL * fraction))
    const { ms, applied, from } = await time(seq)
    scattered += ms
    out(
      String(seq).padStart(10) +
        String(from).padStart(9) +
        String(applied).padStart(9) +
        ms.toFixed(1).padStart(9)
    )
  }

  const start = Math.max(1, TOTAL - PLAYBACK_RUN)
  const began = process.hrtime.bigint()
  for (let seq = start; seq < start + PLAYBACK_RUN; seq += 1) await stateAt(ROOM, seq)
  const playbackMs = Number(process.hrtime.bigint() - began) / 1e6

  out(`  ${PLAYBACK_RUN} consecutive frames: ${playbackMs.toFixed(0)}ms (${(playbackMs / PLAYBACK_RUN).toFixed(1)}ms per frame)`)
  out()
  return { scattered, perFrame: playbackMs / PLAYBACK_RUN }
}

const before = await measure('WITHOUT checkpoints')

const began = process.hrtime.bigint()
const { built, bytes } = await backfillCheckpoints(ROOM)
const buildMs = Number(process.hrtime.bigint() - began) / 1e6
out(`built ${built} checkpoints in ${buildMs.toFixed(0)}ms, ${(bytes / 1024).toFixed(0)} KB total`)
out(`(the log itself is ${((await DocUpdate.aggregate([{ $match: { roomId: ROOM } }, { $group: { _id: null, n: { $sum: '$size' } } }]))[0]?.n / 1024 || 0).toFixed(0)} KB)`)
out()

const after = await measure('WITH checkpoints')

out(`per-frame playback: ${before.perFrame.toFixed(1)}ms -> ${after.perFrame.toFixed(1)}ms  (${(before.perFrame / after.perFrame).toFixed(1)}x)`)
out(`checkpoints stored: ${await Checkpoint.countDocuments({ roomId: ROOM })}`)

await mongoose.disconnect()
await mongod.stop()
