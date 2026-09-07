import { useCallback, useMemo, useState } from 'react'

/**
 * What this person may do in this room, as the server sees it.
 *
 * The capability list comes from the server rather than being worked out here
 * from a role name. That is the whole point: a client that maps role to
 * capability holds a second copy of the rule, and a second copy is a thing to
 * get out of step — usually quietly, usually in the permissive direction.
 *
 * None of this is a security boundary. Every capability is enforced again on
 * the server, at the REST route, on the socket, and on the Yjs connection. All
 * this does is stop the interface offering a button that would fail, which is
 * a courtesy rather than a control.
 */

/** Until the server has answered, assume nothing is allowed. */
const NOTHING = Object.freeze({ role: null, capabilities: [], assignable: [], isGuest: true })

export function useRoomAccess() {
  const [access, setAccess] = useState(NOTHING)
  const [loaded, setLoaded] = useState(false)

  const receive = useCallback((next) => {
    setAccess(next ?? NOTHING)
    setLoaded(true)
  }, [])

  const capabilities = useMemo(() => new Set(access.capabilities ?? []), [access])

  /**
   * Deliberately false until the answer arrives.
   *
   * The alternative — assume allowed, then hide on load — flashes controls
   * that a viewer cannot use, and someone clicking in that window gets a
   * refusal from the server that looks like a bug.
   */
  const can = useCallback((capability) => capabilities.has(capability), [capabilities])

  return useMemo(
    () => ({
      role: access.role,
      isGuest: access.isGuest,
      assignable: access.assignable ?? [],
      loaded,
      can,
      receive,
    }),
    [access, loaded, can, receive]
  )
}

/** The capability names, so no component spells one out as a bare string. */
export const CAP = Object.freeze({
  ROOM_VIEW: 'room:view',
  ROOM_DELETE: 'room:delete',
  ROOM_TRANSFER: 'room:transfer',
  ROOM_SETTINGS: 'room:settings',
  MEMBERS_INVITE: 'members:invite',
  MEMBERS_REMOVE: 'members:remove',
  ROLES_MANAGE: 'roles:manage',
  ADMINS_MANAGE: 'admins:manage',
  WHITEBOARD_EDIT: 'whiteboard:edit',
  CODE_EDIT: 'code:edit',
  FILES_UPLOAD: 'files:upload',
  FILES_DELETE: 'files:delete',
  CHAT_SEND: 'chat:send',
  CODE_EXECUTE: 'code:execute',
  AI_GENERATE: 'ai:generate',
  REPLAY_VIEW: 'replay:view',
})

/** How each role reads in the interface. */
export const ROLE_LABELS = Object.freeze({
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  runner: 'Runner',
  commenter: 'Commenter',
  viewer: 'Viewer',
})

/** One line each, so a person choosing a role knows what they are granting. */
export const ROLE_DESCRIPTIONS = Object.freeze({
  owner: 'Everything, including deleting the room and handing it on',
  admin: 'Manage people, roles and settings — but not delete or transfer',
  editor: 'Draw, edit code, run it, and manage files',
  runner: 'Watch and run the code, without changing it',
  commenter: 'Watch and join the chat',
  viewer: 'Read-only',
})
