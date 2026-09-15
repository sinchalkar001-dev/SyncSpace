import fs from 'node:fs/promises'
import path from 'node:path'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMemoryMongo, stopMemoryMongo } from './helpers/db.js'
import { createRoom, deleteRoom, ensureRoom } from '../src/services/room.service.js'
import { UPLOAD_DIR } from '../src/config/upload.js'
import { Activity } from '../src/models/Activity.js'
import { CommentReadState, CommentThread } from '../src/models/Comment.js'
import { CopilotRun } from '../src/models/CopilotRun.js'
import { Execution } from '../src/models/Execution.js'
import { File } from '../src/models/File.js'
import { RoomPreference } from '../src/models/RoomPreference.js'
import { SessionInsight } from '../src/models/SessionInsight.js'

/**
 * Deleting a room, and what a stranger finds under its code afterwards.
 *
 * A room id is a code anybody can type, and typing one with no record opens a
 * fresh public room under it. So "deleted" has to mean nothing is left for
 * that next room to inherit.
 */

const LEFT_BEHIND = [Activity, CommentThread, CommentReadState, CopilotRun, Execution, File, RoomPreference, SessionInsight]

beforeAll(async () => {
  await startMemoryMongo()
}, 120000)

afterAll(stopMemoryMongo)

describe('deleting a room', () => {
  it('takes its comments, files, runs and answers with it', async () => {
    const owner = new mongoose.Types.ObjectId().toString()
    const room = await createRoom({ name: 'Private interview', ownerId: owner })
    const { roomId } = room

    // Raw rows: what matters is what is keyed by the room, not a valid document.
    for (const Model of LEFT_BEHIND) await Model.collection.insertOne({ roomId })

    const uploads = path.join(UPLOAD_DIR, roomId)
    await fs.mkdir(uploads, { recursive: true })
    await fs.writeFile(path.join(uploads, 'notes.txt'), 'the candidate’s answers')

    try {
      await deleteRoom({ roomId, actorId: owner })

      for (const Model of LEFT_BEHIND) {
        expect(await Model.collection.countDocuments({ roomId }), Model.modelName).toBe(0)
      }
      await expect(fs.access(uploads)).rejects.toThrow()

      // And the stranger's view: the same code, opened again, is empty.
      const reopened = await ensureRoom(roomId)
      expect(reopened.owner ?? null).toBeNull()
      expect(await CommentThread.collection.countDocuments({ roomId })).toBe(0)
    } finally {
      await fs.rm(uploads, { recursive: true, force: true })
    }
  })
})
