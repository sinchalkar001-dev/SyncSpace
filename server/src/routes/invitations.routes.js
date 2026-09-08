import { Router } from 'express'
import { optionalAuth, requireAuth } from '../middleware/auth.js'
import { createRateLimiters } from '../middleware/rateLimit.js'
import { badRequest } from '../errors.js'
import { acceptInvitation, describeInvitation, looksLikeToken } from '../services/invitation.service.js'

/**
 * Redeeming a room invitation.
 *
 * Mounted outside `/rooms` on purpose: the person holding the token does not
 * know the room id, may have no account yet, and certainly has no access to
 * the room the invitation is for. Hanging this off `/rooms/:roomId` would put
 * a route that must work for outsiders behind a path that reads as though it
 * should not.
 */
export function createInvitationsRouter() {
  const router = Router()
  const { inviteLimiter } = createRateLimiters()

  const tokenOf = (req) => {
    const token = req.params.token
    if (!looksLikeToken(token)) {
      throw badRequest('This invitation is invalid or has expired', 'invitation_invalid')
    }
    return token
  }

  /**
   * What the invitation is for, before anybody commits to anything.
   *
   * `optionalAuth`, because the usual reader is somebody who has just followed
   * a link from their email and has not signed in yet — and telling them which
   * room they have been invited to is the thing that makes the sign-up worth
   * finishing. Deliberately thin: the room's name and who invited them, and
   * nothing about who else is in it.
   */
  router.get('/:token', optionalAuth, inviteLimiter, async (req, res, next) => {
    try {
      res.json({ invitation: await describeInvitation(tokenOf(req)) })
    } catch (err) {
      next(err)
    }
  })

  /**
   * Spends the invitation.
   *
   * `requireAuth` because a membership names an account, and the service
   * checks the rest: that the token resolves, that it was sent to this
   * account's address, that the address has been verified, and that the person
   * was not removed from the room since. Accepting removes the invitation, so
   * a second attempt finds nothing at all.
   */
  router.post('/:token/accept', requireAuth, inviteLimiter, async (req, res, next) => {
    try {
      const { room, role } = await acceptInvitation({
        token: tokenOf(req),
        userId: req.user.id,
      })

      res.json({ room: room.toPublic(), role })
    } catch (err) {
      next(err)
    }
  })

  return router
}
