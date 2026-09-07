import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES as C,
  ROLES,
  ROLE_NAMES,
  assignableRoles,
  can,
  canAssignRole,
  capabilitiesFor,
  describeAccess,
  rankOf,
  roleFor,
} from '../src/permissions.js'

/**
 * The permission model on its own, with no database and no HTTP.
 *
 * This is the file that has to be exhaustive. Every other test in the suite
 * checks that one route asks the right question; these check that the answer
 * is right, for every role and every capability, which is the part a route
 * test can only sample.
 *
 * The escalation cases matter most. A permission system is not defeated by
 * someone calling an endpoint they cannot reach — it is defeated by someone
 * who can legitimately reach the role endpoint using it to award themselves
 * one more rung.
 */

/** A room object shaped like the Mongoose document, with its methods. */
const roomWith = ({ owner = null, members = [], isPublic = false, blocked = [], guestRole } = {}) => ({
  owner,
  members,
  isPublic,
  guestRole,
  isBlocked: (id) => blocked.some((b) => String(b) === String(id)),
})

const OWNER_ID = 'owner-1'
const MEMBER_ID = 'member-1'

describe('working out somebody’s role', () => {
  it('calls the owner the owner, whatever else the members list says', () => {
    const room = roomWith({ owner: OWNER_ID, members: [{ user: OWNER_ID, role: 'viewer' }] })
    expect(roleFor(room, OWNER_ID)).toBe(ROLES.OWNER)
  })

  it('reads a member’s role from their membership', () => {
    const room = roomWith({ owner: OWNER_ID, members: [{ user: MEMBER_ID, role: 'commenter' }] })
    expect(roleFor(room, MEMBER_ID)).toBe(ROLES.COMMENTER)
  })

  it('gives a stranger nothing in a private room', () => {
    expect(roleFor(roomWith({ owner: OWNER_ID }), 'nobody')).toBeNull()
  })

  /**
   * A public room has always let anyone who opens the link draw on it. Turning
   * every guest into a viewer would break rooms that work today.
   */
  it('keeps a guest in a public room able to edit, as they always could', () => {
    expect(roleFor(roomWith({ isPublic: true }), null)).toBe(ROLES.EDITOR)
  })

  it('honours a room that has chosen a stricter guest role', () => {
    expect(roleFor(roomWith({ isPublic: true, guestRole: 'viewer' }), null)).toBe(ROLES.VIEWER)
  })

  it('refuses somebody who was removed, even from a public room', () => {
    const room = roomWith({ isPublic: true, blocked: [MEMBER_ID] })
    expect(roleFor(room, MEMBER_ID)).toBeNull()
  })

  /**
   * A membership written before roles were enforced, or one naming a role that
   * no longer exists, must fail closed. Reading it as full access is how a
   * schema change becomes a privilege grant.
   */
  it('treats an unrecognised stored role as read-only, not as access', () => {
    const room = roomWith({ owner: OWNER_ID, members: [{ user: MEMBER_ID, role: 'superuser' }] })
    expect(roleFor(room, MEMBER_ID)).toBe(ROLES.VIEWER)
  })
})

describe('what each role can do', () => {
  const room = (role) => roomWith({ owner: OWNER_ID, members: [{ user: MEMBER_ID, role }] })
  const allows = (role, capability) => can(room(role), MEMBER_ID, capability)

  it('lets an owner do everything there is', () => {
    const owned = roomWith({ owner: OWNER_ID })
    for (const capability of Object.values(C)) {
      expect(can(owned, OWNER_ID, capability), capability).toBe(true)
    }
  })

  /** The three that separate an admin from an owner. */
  it('stops an admin deleting the room, transferring it, or making admins', () => {
    expect(allows(ROLES.ADMIN, C.ROOM_DELETE)).toBe(false)
    expect(allows(ROLES.ADMIN, C.ROOM_TRANSFER)).toBe(false)
    expect(allows(ROLES.ADMIN, C.ADMINS_MANAGE)).toBe(false)

    // But everything else about running the room is theirs.
    expect(allows(ROLES.ADMIN, C.MEMBERS_INVITE)).toBe(true)
    expect(allows(ROLES.ADMIN, C.ROLES_MANAGE)).toBe(true)
    expect(allows(ROLES.ADMIN, C.ROOM_SETTINGS)).toBe(true)
  })

  it('lets an editor change the work but not who is in the room', () => {
    expect(allows(ROLES.EDITOR, C.WHITEBOARD_EDIT)).toBe(true)
    expect(allows(ROLES.EDITOR, C.CODE_EDIT)).toBe(true)
    expect(allows(ROLES.EDITOR, C.FILES_UPLOAD)).toBe(true)
    // Unchanged from before roles were enforced: an editor could always run.
    expect(allows(ROLES.EDITOR, C.CODE_EXECUTE)).toBe(true)

    expect(allows(ROLES.EDITOR, C.MEMBERS_INVITE)).toBe(false)
    expect(allows(ROLES.EDITOR, C.ROLES_MANAGE)).toBe(false)
    expect(allows(ROLES.EDITOR, C.ROOM_SETTINGS)).toBe(false)
  })

  it('lets a commenter talk and nothing else', () => {
    expect(allows(ROLES.COMMENTER, C.CHAT_SEND)).toBe(true)
    expect(allows(ROLES.COMMENTER, C.ROOM_VIEW)).toBe(true)

    expect(allows(ROLES.COMMENTER, C.WHITEBOARD_EDIT)).toBe(false)
    expect(allows(ROLES.COMMENTER, C.CODE_EDIT)).toBe(false)
    expect(allows(ROLES.COMMENTER, C.CODE_EXECUTE)).toBe(false)
    expect(allows(ROLES.COMMENTER, C.FILES_UPLOAD)).toBe(false)
  })

  /** The whole point of the role: run it, do not change it. */
  it('lets a runner execute without being able to edit', () => {
    expect(allows(ROLES.RUNNER, C.CODE_EXECUTE)).toBe(true)
    expect(allows(ROLES.RUNNER, C.CODE_EDIT)).toBe(false)
    expect(allows(ROLES.RUNNER, C.WHITEBOARD_EDIT)).toBe(false)
  })

  it('lets a viewer only look', () => {
    expect(allows(ROLES.VIEWER, C.ROOM_VIEW)).toBe(true)
    expect(allows(ROLES.VIEWER, C.REPLAY_VIEW)).toBe(true)

    for (const capability of [C.CHAT_SEND, C.CODE_EDIT, C.CODE_EXECUTE, C.WHITEBOARD_EDIT]) {
      expect(allows(ROLES.VIEWER, capability), capability).toBe(false)
    }
  })

  it('gives a blocked person nothing at all', () => {
    const room = roomWith({ isPublic: true, blocked: [MEMBER_ID] })
    for (const capability of Object.values(C)) {
      expect(can(room, MEMBER_ID, capability), capability).toBe(false)
    }
  })

  /**
   * Each role must be a superset of the one below, or the ranking used to
   * prevent escalation would not mean what it says.
   */
  it('grants strictly more the further up the ranking you go', () => {
    const ordered = [...ROLE_NAMES].sort((a, b) => rankOf(a) - rankOf(b))

    for (let i = 1; i < ordered.length; i += 1) {
      const lower = new Set(capabilitiesFor(ordered[i - 1]))
      const higher = new Set(capabilitiesFor(ordered[i]))

      for (const capability of lower) {
        expect(higher.has(capability), ordered[i] + ' is missing ' + capability).toBe(true)
      }
    }
  })
})

describe('guests', () => {
  const publicRoom = roomWith({ isPublic: true })

  it('can do the things that do not name a person', () => {
    expect(can(publicRoom, null, C.CODE_EDIT)).toBe(true)
    expect(can(publicRoom, null, C.WHITEBOARD_EDIT)).toBe(true)
    expect(can(publicRoom, null, C.CODE_EXECUTE)).toBe(true)
    expect(can(publicRoom, null, C.CHAT_SEND)).toBe(true)
  })

  /**
   * A guest identity is a display name typed into a box. Anything that records
   * who did it, or decides who may enter, needs an account behind it.
   */
  it('cannot do anything that permanently names them or changes the guest list', () => {
    for (const capability of [
      C.FILES_UPLOAD,
      C.FILES_DELETE,
      C.AI_GENERATE,
      C.MEMBERS_INVITE,
      C.ROLES_MANAGE,
      C.ROOM_SETTINGS,
      C.ROOM_DELETE,
    ]) {
      expect(can(publicRoom, null, capability), capability).toBe(false)
    }
  })

  it('gets nothing from a private room', () => {
    expect(can(roomWith({ owner: OWNER_ID }), null, C.ROOM_VIEW)).toBe(false)
  })
})

describe('privilege escalation', () => {
  const attempt = (actorRole, targetRole, nextRole) =>
    canAssignRole({ actorRole, targetRole, nextRole })

  it('lets an owner appoint an admin', () => {
    expect(attempt(ROLES.OWNER, ROLES.EDITOR, ROLES.ADMIN)).toBe(true)
  })

  /** The obvious one: an admin manufacturing a peer. */
  it('stops an admin appointing another admin', () => {
    expect(attempt(ROLES.ADMIN, ROLES.EDITOR, ROLES.ADMIN)).toBe(false)
  })

  it('stops an admin demoting another admin', () => {
    expect(attempt(ROLES.ADMIN, ROLES.ADMIN, ROLES.VIEWER)).toBe(false)
  })

  it('stops an admin demoting the owner', () => {
    expect(attempt(ROLES.ADMIN, ROLES.OWNER, ROLES.VIEWER)).toBe(false)
  })

  /** Ownership moves by transfer alone, never by editing a membership row. */
  it('never grants ownership through role assignment, not even by the owner', () => {
    expect(attempt(ROLES.OWNER, ROLES.ADMIN, ROLES.OWNER)).toBe(false)
  })

  it('stops anyone without the capability assigning anything', () => {
    for (const role of [ROLES.EDITOR, ROLES.RUNNER, ROLES.COMMENTER, ROLES.VIEWER]) {
      expect(attempt(role, ROLES.VIEWER, ROLES.EDITOR), role).toBe(false)
    }
  })

  it('lets an admin manage the ranks below them', () => {
    expect(attempt(ROLES.ADMIN, ROLES.VIEWER, ROLES.EDITOR)).toBe(true)
    expect(attempt(ROLES.ADMIN, ROLES.EDITOR, ROLES.COMMENTER)).toBe(true)
  })

  it('refuses a role that does not exist', () => {
    expect(attempt(ROLES.OWNER, ROLES.EDITOR, 'superuser')).toBe(false)
    expect(attempt(ROLES.OWNER, ROLES.EDITOR, undefined)).toBe(false)
  })

  it('offers a menu that matches what it will actually accept', () => {
    for (const actorRole of ROLE_NAMES) {
      for (const nextRole of assignableRoles(actorRole)) {
        expect(attempt(actorRole, null, nextRole), actorRole + '->' + nextRole).toBe(true)
      }
    }

    expect(assignableRoles(ROLES.OWNER)).toContain(ROLES.ADMIN)
    expect(assignableRoles(ROLES.ADMIN)).not.toContain(ROLES.ADMIN)
    expect(assignableRoles(ROLES.EDITOR)).toEqual([])
  })
})

describe('what the client is told', () => {
  it('sends the capabilities rather than the role alone', () => {
    const room = roomWith({ owner: OWNER_ID, members: [{ user: MEMBER_ID, role: 'runner' }] })
    const access = describeAccess(room, MEMBER_ID)

    expect(access.role).toBe(ROLES.RUNNER)
    expect(access.capabilities).toContain(C.CODE_EXECUTE)
    expect(access.capabilities).not.toContain(C.CODE_EDIT)
    expect(access.isGuest).toBe(false)
  })

  it('does not offer a guest the things an account is needed for', () => {
    const access = describeAccess(roomWith({ isPublic: true }), null)

    expect(access.isGuest).toBe(true)
    expect(access.capabilities).toContain(C.CODE_EDIT)
    expect(access.capabilities).not.toContain(C.FILES_UPLOAD)
  })

  it('says plainly that somebody with no access has none', () => {
    const access = describeAccess(roomWith({ owner: OWNER_ID }), 'stranger')

    expect(access.role).toBeNull()
    expect(access.capabilities).toEqual([])
    expect(access.assignable).toEqual([])
  })
})
