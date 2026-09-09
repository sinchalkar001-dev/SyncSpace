import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { listActivityForRooms } from '../services/activity.service.js'
import { listRoomsForUser } from '../services/room.service.js'

/**
 * What has been happening across everything this person is part of.
 *
 * Its own router rather than a path under `/rooms`, because the only spellings
 * available there compete with `/rooms/:roomId` - a literal segment and a
 * parameter at the same depth work only while nobody reorders the file, and a
 * room whose code happened to be "activity" would quietly shadow the feed.
 *
 * The room list is resolved first and the feed is read from those ids, so
 * access is decided by the same membership query the dashboard itself uses.
 * Working out visibility inside the activity query would be a second, subtly
 * different answer to "which rooms may this person see", and the failure mode
 * of getting it wrong is telling somebody what happened in a room they were
 * removed from.
 */
export function createActivityRouter() {
  const router = Router()

  router.get('/', requireAuth, async (req, res, next) => {
    try {
      const rooms = await listRoomsForUser(req.user.id)

      res.json({
        activity: await listActivityForRooms(
          rooms.map((room) => room.roomId),
          { limit: req.query.limit }
        ),
      })
    } catch (err) {
      next(err)
    }
  })

  return router
}
