/**
 * Who may do what in a room.
 *
 * Before this, `member.role` was written on every membership and read by
 * nothing. An "editor" and a "viewer" had identical power: both could redraw
 * the whiteboard, rewrite the buffer and run code, because the only question
 * ever asked was `canAccess` — are you allowed in the room at all. The field
 * described an intention the server never enforced, which is the worst kind of
 * permission: it appears in the interface, people rely on it, and it does
 * nothing.
 *
 * Everything about authorisation now goes through this one module. Not for
 * tidiness — because a permission system with two implementations has one
 * implementation and one hole, and the hole is always the surface nobody
 * remembered: the WebSocket, the Yjs document, the file upload. Each of those
 * asks `can()` here, so a capability can only be granted in one place.
 *
 * The rule for changing this file: a new capability is denied by default. Add
 * it to `CAPABILITIES`, then grant it explicitly to the roles that should have
 * it. Never write a check that asks "is this role not X" — that grants every
 * role added afterwards.
 */

/**
 * Ordered by authority, and the number is load-bearing.
 *
 * Privilege escalation is prevented by comparing ranks rather than by listing
 * forbidden pairs: you may only grant a role strictly below your own, and you
 * may not touch anybody whose rank is at or above yours. A list of pairs would
 * need revisiting every time a role is added; a comparison does not.
 */
export const ROLES = Object.freeze({
  OWNER: 'owner',
  ADMIN: 'admin',
  EDITOR: 'editor',
  RUNNER: 'runner',
  COMMENTER: 'commenter',
  VIEWER: 'viewer',
})

export const ROLE_NAMES = Object.freeze(Object.values(ROLES))

const RANK = Object.freeze({
  [ROLES.OWNER]: 100,
  [ROLES.ADMIN]: 80,
  [ROLES.EDITOR]: 60,
  [ROLES.RUNNER]: 40,
  [ROLES.COMMENTER]: 30,
  [ROLES.VIEWER]: 10,
})

export const rankOf = (role) => RANK[role] ?? 0

/**
 * Every distinct thing a person can do.
 *
 * Deliberately finer than the roles. A capability is what the server checks;
 * a role is only a bundle of them, and keeping the two apart is what lets the
 * bundles change without hunting for `role === 'editor'` across the codebase.
 */
export const CAPABILITIES = Object.freeze({
  ROOM_VIEW: 'room:view',
  ROOM_DELETE: 'room:delete',
  ROOM_TRANSFER: 'room:transfer',
  ROOM_SETTINGS: 'room:settings',

  MEMBERS_INVITE: 'members:invite',
  MEMBERS_REMOVE: 'members:remove',
  /** Assigning roles. Bounded further by rank — see `canAssignRole`. */
  ROLES_MANAGE: 'roles:manage',
  /** Granting or revoking admin specifically. Owner only. */
  ADMINS_MANAGE: 'admins:manage',

  WHITEBOARD_EDIT: 'whiteboard:edit',
  CODE_EDIT: 'code:edit',
  FILES_UPLOAD: 'files:upload',
  FILES_DELETE: 'files:delete',

  CHAT_SEND: 'chat:send',
  CODE_EXECUTE: 'code:execute',
  AI_GENERATE: 'ai:generate',
  REPLAY_VIEW: 'replay:view',

  /** Opening, replying to, resolving and reopening comment threads. */
  COMMENT_WRITE: 'comments:write',
  /** Deleting other people's comments. Everybody may delete their own. */
  COMMENT_MODERATE: 'comments:moderate',
})

const C = CAPABILITIES

/** Read-only access, and the floor every other role builds on. */
const VIEWER = [C.ROOM_VIEW, C.REPLAY_VIEW]

/** Can say things, cannot change anything. */
const COMMENTER = [...VIEWER, C.CHAT_SEND, C.COMMENT_WRITE]

/**
 * A commenter who may press Run.
 *
 * The role only earns its place read this way. An editor can already execute —
 * that is how the room has always worked and taking it away would be a
 * regression — so a separate "runner" is meaningful precisely when it lets
 * somebody run the code without being able to change it. That is the
 * interview case the room was built for: a candidate runs the tests, and the
 * buffer stays as the interviewer left it.
 */
const RUNNER = [...COMMENTER, C.CODE_EXECUTE]

/** Everything to do with the work itself, and nothing about who may see it. */
const EDITOR = [
  ...COMMENTER,
  C.WHITEBOARD_EDIT,
  C.CODE_EDIT,
  C.FILES_UPLOAD,
  C.FILES_DELETE,
  C.CODE_EXECUTE,
  C.AI_GENERATE,
  C.COMMENT_MODERATE,
]

/** Everything an editor can do, plus deciding who else is in the room. */
const ADMIN = [
  ...EDITOR,
  C.ROOM_SETTINGS,
  C.MEMBERS_INVITE,
  C.MEMBERS_REMOVE,
  C.ROLES_MANAGE,
]

/**
 * Everything, including the three an admin deliberately lacks: deleting the
 * room, handing it to somebody else, and making another admin. An admin who
 * could appoint admins could appoint themselves a peer for every removal an
 * owner might make, and an admin who could delete the room could end it
 * without owning it.
 */
const OWNER = [...ADMIN, C.ROOM_DELETE, C.ROOM_TRANSFER, C.ADMINS_MANAGE]

const GRANTS = Object.freeze({
  [ROLES.OWNER]: Object.freeze(new Set(OWNER)),
  [ROLES.ADMIN]: Object.freeze(new Set(ADMIN)),
  [ROLES.EDITOR]: Object.freeze(new Set(EDITOR)),
  [ROLES.RUNNER]: Object.freeze(new Set(RUNNER)),
  [ROLES.COMMENTER]: Object.freeze(new Set(COMMENTER)),
  [ROLES.VIEWER]: Object.freeze(new Set(VIEWER)),
})

/** What a role may do, as a plain array — for the API and the interface. */
export function capabilitiesFor(role) {
  return [...(GRANTS[role] ?? [])]
}

export const isRole = (value) => ROLE_NAMES.includes(value)

/**
 * The role somebody holds in a room, or null if they are not welcome in it.
 *
 * Guests are the interesting case. A public room has always let anyone who
 * opens the link draw on it, and quietly turning every guest into a viewer
 * would break rooms that work today — so the room carries its own `guestRole`,
 * defaulting to editor. An owner who wants a read-only public room now sets it
 * rather than being unable to express it.
 */
export function roleFor(room, userId) {
  if (!room) return null

  // A removal outranks everything else, including ownership of a public link.
  if (userId && room.isBlocked?.(userId)) return null

  if (userId && room.owner && String(room.owner) === String(userId)) return ROLES.OWNER

  if (userId) {
    const member = room.members?.find((entry) => String(entry.user) === String(userId))
    if (member) {
      // A legacy membership stored before roles were enforced, or one whose
      // role was removed from the enum, is treated as the safest thing it
      // could have meant rather than as full access.
      return isRole(member.role) ? member.role : ROLES.VIEWER
    }
  }

  if (room.isPublic) return room.guestRole && isRole(room.guestRole) ? room.guestRole : ROLES.EDITOR

  return null
}

/**
 * The one question every guard in the system asks.
 *
 * `userId` may be null: that is a guest, and a guest in a public room has a
 * role like anybody else. What a guest cannot have is anything that names a
 * person — see `requiresAccount`.
 */
export function can(room, userId, capability) {
  const role = roleFor(room, userId)
  if (!role) return false
  if (!GRANTS[role]?.has(capability)) return false
  if (!userId && requiresAccount(capability)) return false
  return true
}

/**
 * Capabilities that cannot be exercised without an account, whatever the
 * room's guest role says.
 *
 * Everything here either names somebody permanently (a file's uploader, a
 * generation's author) or changes who may enter — and a guest identity is a
 * display name typed into a box, which is not something to hang either on.
 */
const ACCOUNT_ONLY = Object.freeze(
  new Set([
    // A comment names its author for good, and a guest is a name typed into a box.
    C.COMMENT_WRITE,
    C.COMMENT_MODERATE,
    C.ROOM_DELETE,
    C.ROOM_TRANSFER,
    C.ROOM_SETTINGS,
    C.MEMBERS_INVITE,
    C.MEMBERS_REMOVE,
    C.ROLES_MANAGE,
    C.ADMINS_MANAGE,
    C.FILES_UPLOAD,
    C.FILES_DELETE,
    C.AI_GENERATE,
  ])
)

export const requiresAccount = (capability) => ACCOUNT_ONLY.has(capability)

/**
 * Whether `actor` may give `target` the role `next`.
 *
 * Three rules, and each closes a specific way of climbing:
 *
 *  - You cannot grant a role at or above your own. Otherwise an admin appoints
 *    a second admin, or themselves an owner.
 *  - You cannot change somebody at or above your own rank. Otherwise an admin
 *    demotes the owner, or another admin, and then does as they please.
 *  - Only an owner deals in admins at all, in either direction.
 *
 * Ownership is never granted through this path; it moves only by transfer,
 * which is one deliberate act with one obvious consequence.
 */
export function canAssignRole({ actorRole, targetRole, nextRole }) {
  if (!isRole(nextRole) || nextRole === ROLES.OWNER) return false
  if (!GRANTS[actorRole]?.has(C.ROLES_MANAGE)) return false

  const actor = rankOf(actorRole)

  if (rankOf(nextRole) >= actor) return false
  if (targetRole && rankOf(targetRole) >= actor) return false

  const touchesAdmin = nextRole === ROLES.ADMIN || targetRole === ROLES.ADMIN
  if (touchesAdmin && !GRANTS[actorRole]?.has(C.ADMINS_MANAGE)) return false

  return true
}

/** Every role `actorRole` is allowed to hand out, for populating a menu. */
export function assignableRoles(actorRole) {
  return ROLE_NAMES.filter((role) => canAssignRole({ actorRole, targetRole: null, nextRole: role }))
}

/**
 * What the client is told about itself, so the interface can hide what it
 * cannot do rather than offering buttons that fail.
 *
 * The list is sent rather than the role alone: the client should not be
 * reimplementing the mapping from role to capability, because a second copy of
 * that mapping is a second thing to get out of step.
 */
export function describeAccess(room, userId) {
  const role = roleFor(room, userId)

  return {
    role,
    capabilities: role ? capabilitiesFor(role).filter((c) => userId || !requiresAccount(c)) : [],
    assignable: role ? assignableRoles(role) : [],
    isGuest: !userId,
  }
}

/** Human wording for a refusal, so the reason reaches the person. */
export const CAPABILITY_LABELS = Object.freeze({
  [C.ROOM_VIEW]: 'open this room',
  [C.ROOM_DELETE]: 'delete this room',
  [C.ROOM_TRANSFER]: 'transfer this room',
  [C.ROOM_SETTINGS]: 'change this room’s settings',
  [C.MEMBERS_INVITE]: 'invite people',
  [C.MEMBERS_REMOVE]: 'remove people',
  [C.ROLES_MANAGE]: 'change what people can do',
  [C.ADMINS_MANAGE]: 'manage admins',
  [C.WHITEBOARD_EDIT]: 'draw on the whiteboard',
  [C.CODE_EDIT]: 'edit the code',
  [C.FILES_UPLOAD]: 'upload files',
  [C.FILES_DELETE]: 'delete files',
  [C.CHAT_SEND]: 'send messages',
  [C.CODE_EXECUTE]: 'run code',
  [C.AI_GENERATE]: 'generate code from the whiteboard',
  [C.REPLAY_VIEW]: 'watch this room’s history',
  [C.COMMENT_WRITE]: 'comment on this room',
  [C.COMMENT_MODERATE]: 'delete other people’s comments',
})
