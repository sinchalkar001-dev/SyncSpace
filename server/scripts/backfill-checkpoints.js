/**
 * Gives rooms that predate checkpoints the ones they should already have.
 *
 *   node scripts/backfill-checkpoints.js            # every room
 *   node scripts/backfill-checkpoints.js MSTTPQuJ   # one room
 *
 * A room being edited lays down its own checkpoints as it goes, because the
 * write path records each interval boundary it passes. A room whose history
 * was written before any of that existed has none, and never gets one for the
 * part of its log already behind it — so its replay stays as slow as it ever
 * was. This walks those rooms once.
 *
 * Safe to run repeatedly and safe to run against a live database: it only ever
 * adds or repairs checkpoints, and a checkpoint is a derived read cache. The
 * update log itself is never touched.
 */
import { connectDatabase, disconnectDatabase } from '../src/db/connect.js'
import { DocUpdate } from '../src/models/DocUpdate.js'
import { backfillCheckpoints, CHECKPOINT_EVERY } from '../src/services/replay.service.js'

const only = process.argv[2]
const out = (line = '') => process.stdout.write(line + '\n')
const kb = (bytes) => (bytes / 1024).toFixed(0) + ' KB'

await connectDatabase()

/** Rooms that have a log at all, longest first — those gain the most. */
const rooms = await DocUpdate.aggregate([
  ...(only ? [{ $match: { roomId: only } }] : []),
  { $group: { _id: '$roomId', entries: { $sum: 1 } } },
  { $sort: { entries: -1 } },
])

if (rooms.length === 0) {
  out(only ? 'no update log for room ' + only : 'no room has an update log yet')
} else {
  out(`${rooms.length} room${rooms.length === 1 ? '' : 's'} with a log\n`)
  out('room                entries   built      stored')

  let built = 0
  let bytes = 0

  for (const room of rooms) {
    // Below one interval there is nothing a checkpoint could stand in for.
    if (room.entries < CHECKPOINT_EVERY) {
      out(String(room._id).padEnd(20) + String(room.entries).padStart(7) + '        -  (too short)')
      continue
    }

    const result = await backfillCheckpoints(room._id)
    built += result.built
    bytes += result.bytes

    out(
      String(room._id).padEnd(20) +
        String(room.entries).padStart(7) +
        String(result.built).padStart(8) +
        kb(result.bytes).padStart(12)
    )
  }

  out()
  out(`built ${built} checkpoints, ${kb(bytes)}`)
  if (built === 0) out('(everything was already checkpointed)')
}

await disconnectDatabase()
