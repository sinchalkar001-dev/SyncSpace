import { useCallback, useMemo, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { useDismissable } from '../hooks/useDismissable.js'
import { useRoomPeople } from '../hooks/useRoomPeople.js'
import { useToast } from './ui/useToast.js'
import { PresenceBar } from './PresenceBar.jsx'
import { InviteForm, PersonRow } from './PeopleList.jsx'
import { Button } from './ui/Button.jsx'
import { Icon } from './ui/Icon.jsx'
import { Skeleton } from './ui/Skeleton.jsx'

/**
 * The avatar stack in the room header, and what is behind it.
 *
 * The stack always said how many people were in the room but never who, which
 * left the one question an owner actually has — who is this, and can I get
 * them out — with no answer anywhere in the room. Clicking it opens the roster:
 * everyone connected right now, everyone invited, everyone removed, and for
 * the owner, the controls to change any of that.
 *
 * The live half comes from awareness rather than the API, so it matches the
 * count on the trigger exactly. The invited half needs the roster endpoint,
 * which is members-only — hence `useRoomPeople` being switched off for guests.
 */
export function PresenceMenu({ room, roomId, self, peers, user, onRoomChange }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const containerRef = useRef(null)
  const triggerRef = useRef(null)

  const close = useCallback(() => setOpen(false), [])
  useDismissable(open, close, { containerRef, triggerRef, captureEscape: true })

  const isOwner = Boolean(room?.owner && user?.id && room.owner === user.id)
  const { state, people, error, pending, invite, remove, allow } = useRoomPeople(roomId, {
    enabled: open && Boolean(user?.id),
  })

  const live = useMemo(() => [self, ...peers].filter(Boolean), [self, peers])
  const liveIds = useMemo(
    () => new Set(live.map((entry) => entry.user?.id).filter(Boolean)),
    [live]
  )
  const emails = useMemo(() => {
    const byId = new Map()
    for (const member of people?.members ?? []) byId.set(member.id, member.email)
    return byId
  }, [people])

  // Anyone invited who is not currently connected. The ones who are appear in
  // the live list already, and listing them twice reads like two people.
  const away = (people?.members ?? []).filter((member) => !liveIds.has(member.id))
  const guestsPresent = live.some((entry) => entry.user?.guest)

  const removable = (entry) =>
    isOwner &&
    Boolean(entry.user?.id) &&
    !entry.user.guest &&
    entry.user.id !== user?.id &&
    entry.user.id !== room?.owner

  const makePrivate = async () => {
    setClosing(true)
    try {
      const { room: updated } = await api.updateRoom(roomId, { isPublic: false })
      onRoomChange?.(updated)
      toast.success('Only invited people can open this room now')
    } catch (cause) {
      toast.error(cause.message)
    } finally {
      setClosing(false)
    }
  }

  return (
    <div className="presence-menu" ref={containerRef}>
      <button
        type="button"
        className="presence-menu__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={'People in this room (' + live.length + ')'}
        ref={triggerRef}
      >
        <PresenceBar self={self} peers={peers} />
        <Icon name="chevronDown" size={12} className="presence-menu__chevron" />
      </button>

      {open && (
        <div className="presence-menu__panel" role="dialog" aria-label="People in this room">
          <section aria-label="In the room now">
            <h3 className="people__heading">In the room now</h3>
            <ul className="people__list">
              {live.map((entry) => (
                <PersonRow
                  key={entry.clientId}
                  name={entry.user?.name || 'Someone'}
                  color={entry.user?.color}
                  detail={
                    entry.user?.id === user?.id
                      ? 'You'
                      : emails.get(entry.user?.id) || (entry.user?.guest ? 'Joined by link' : null)
                  }
                  tag={
                    entry.user?.id && entry.user.id === room?.owner
                      ? 'owner'
                      : entry.user?.guest
                        ? 'guest'
                        : null
                  }
                  action={
                    removable(entry)
                      ? {
                          label: 'Remove',
                          icon: 'close',
                          variant: 'danger',
                          title: 'Remove from this room and keep them out',
                          loading: pending === entry.user.id,
                          onClick: () => remove({ id: entry.user.id, name: entry.user.name }),
                        }
                      : null
                  }
                />
              ))}
            </ul>
          </section>

          {state === 'loading' && (
            <div className="people__list" aria-hidden="true" style={{ padding: 8 }}>
              <Skeleton width="60%" />
            </div>
          )}

          {state === 'error' && isOwner && (
            <div className="banner banner--error" role="alert">
              <Icon name="alert" size={15} className="banner__icon" />
              <span>{error}</span>
            </div>
          )}

          {state === 'ready' && away.length > 0 && (
            <section aria-label="Invited, not here">
              <h3 className="people__heading">Invited, not here</h3>
              <ul className="people__list">
                {away.map((member) => (
                  <PersonRow
                    key={member.id}
                    name={member.name}
                    detail={member.email}
                    tag={member.role}
                    muted
                    action={
                      isOwner && member.id !== room?.owner
                        ? {
                            label: 'Remove',
                            icon: 'close',
                            title: 'Withdraw their access to this room',
                            loading: pending === member.id,
                            onClick: () => remove(member),
                          }
                        : null
                    }
                  />
                ))}
              </ul>
            </section>
          )}

          {state === 'ready' && isOwner && people.blocked?.length > 0 && (
            <section aria-label="Removed from this room">
              <h3 className="people__heading">Removed</h3>
              <ul className="people__list">
                {people.blocked.map((person) => (
                  <PersonRow
                    key={person.id}
                    name={person.name}
                    detail={person.email}
                    muted
                    action={{
                      label: 'Allow back',
                      icon: 'check',
                      title: 'Let them open this room again',
                      loading: pending === person.id,
                      onClick: () => allow(person),
                    }}
                  />
                ))}
              </ul>
            </section>
          )}

          {isOwner && state !== 'loading' && (
            <InviteForm
              onInvite={invite}
              pending={pending === 'invite'}
              hint="They need a SyncSpace account under that address."
            />
          )}

          {isOwner && room?.isPublic && (
            <div className="presence-menu__footer">
              <span className="muted">
                {guestsPresent
                  ? 'Guests came in through the link, so there is no account to remove.'
                  : 'Anyone with the link can open this room.'}
              </span>
              <Button size="sm" icon="lock" loading={closing} onClick={makePrivate}>
                Make private
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
