import { useCallback, useMemo, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { useDismissable } from '../hooks/useDismissable.js'
import { useRoomPeople } from '../hooks/useRoomPeople.js'
import { useToast } from './ui/useToast.js'
import { PresenceBar } from './PresenceBar.jsx'
import { INVITE_HINT, InviteForm, PersonRow, RoleSelect } from './PeopleList.jsx'
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '../hooks/useRoomAccess.js'
import { Button } from './ui/Button.jsx'
import { Icon } from './ui/Icon.jsx'
import { Skeleton } from './ui/Skeleton.jsx'
import { canFocus, canFollow, describePresence } from '../lib/presence.js'

/**
 * The line under somebody's name: a coloured dot and what they are doing.
 *
 * The dot carries the tone - active, idle, away - and the words carry the
 * meaning, so nothing depends on telling green from amber.
 */
function LiveStatus({ presence, you = false }) {
  const { tone, status } = describePresence(presence)

  return (
    <span className={'presence-status presence-status--' + tone}>
      {you && (
        <>
          <span>You</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <span className="presence-status__dot" aria-hidden="true" />
      {status}
    </span>
  )
}

/**
 * Follow and go-to, for one person.
 *
 * Disabled rather than hidden for somebody who is not sharing, with the reason
 * in the tooltip: a control that vanishes for one row and not the next reads
 * as a bug, and one that is visibly unavailable reads as their choice.
 */
function PeerTools({ entry, presence, onDone }) {
  const name = entry.user?.name || 'Someone'
  const followed = presence.following === entry.clientId
  const followable = canFollow(entry)
  const findable = canFocus(entry)
  const unshared = name + ' is not sharing their activity'

  return (
    <span className="people__tools">
      <button
        type="button"
        className={'people__tool' + (followed ? ' is-on' : '')}
        aria-pressed={followed}
        aria-label={(followed ? 'Stop following ' : 'Follow ') + name}
        title={
          followed
            ? 'Stop following (Esc)'
            : followable
              ? 'Follow - your view moves with theirs'
              : unshared
        }
        disabled={!followed && !followable}
        onClick={() => {
          if (followed) {
            presence.unfollow()
            return
          }
          if (presence.follow(entry.clientId)) onDone()
        }}
      >
        <Icon name="eye" size={14} />
      </button>
      <button
        type="button"
        className="people__tool"
        aria-label={'Go to ' + name}
        title={findable ? 'Jump to where ' + name + ' is' : unshared}
        disabled={!findable}
        onClick={() => {
          if (presence.focus(entry.clientId)) onDone()
        }}
      >
        <Icon name="cursor" size={14} />
      </button>
    </span>
  )
}

/** "Ayush is following you", or a count once it stops fitting on a line. */
function followedBy(followers) {
  if (!followers?.length) return null
  if (followers.length === 1) return followers[0].name + ' is following you'
  return followers.length + ' people are following you'
}

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
export function PresenceMenu({
  room,
  roomId,
  self,
  peers,
  user,
  onRoomChange,
  access,
  presence,
  sharing = true,
  onSharingChange,
}) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const containerRef = useRef(null)
  const triggerRef = useRef(null)

  const close = useCallback(() => setOpen(false), [])
  useDismissable(open, close, { containerRef, triggerRef, captureEscape: true })

  const isOwner = Boolean(room?.owner && user?.id && room.owner === user.id)
  const assignable = access?.assignable ?? []
  const { state, people, error, pending, invite, remove, allow, cancelInvite, setRole } = useRoomPeople(roomId, {
    enabled: open && Boolean(user?.id),
  })

  const live = useMemo(() => [self, ...peers].filter(Boolean), [self, peers])
  const liveIds = useMemo(
    () => new Set(live.map((entry) => entry.user?.id).filter(Boolean)),
    [live]
  )

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
              {live.map((entry) => {
                const you = entry.clientId === self?.clientId
                const { place } = describePresence(entry.presence)

                return (
                <PersonRow
                  key={entry.clientId}
                  name={entry.user?.name || 'Someone'}
                  color={entry.user?.color}
                  detail={<LiveStatus presence={entry.presence} you={you} />}
                  extra={you ? followedBy(presence?.followers) || place : place}
                  tools={
                    !presence ? null : you ? (
                      <span className="people__tools">
                        <button
                          type="button"
                          className={'people__tool' + (sharing ? ' is-on' : '')}
                          aria-pressed={sharing}
                          aria-label="Share your activity"
                          title={
                            sharing
                              ? 'Others can see your line and selection, and follow you'
                              : 'Your line, selection and pointer stay on this machine'
                          }
                          onClick={() => onSharingChange?.(!sharing)}
                        >
                          <Icon name={sharing ? 'eye' : 'eyeOff'} size={14} />
                        </button>
                      </span>
                    ) : (
                      <PeerTools entry={entry} presence={presence} onDone={close} />
                    )
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
                )
              })}
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
                    extra={
                      <span className="presence-status presence-status--offline">
                        <span className="presence-status__dot" aria-hidden="true" />
                        Offline
                      </span>
                    }
                    tag={
                      member.id === room?.owner ? (
                        ROLE_LABELS.owner
                      ) : (
                        <RoleSelect
                          value={member.role}
                          options={assignable}
                          busy={pending === member.id}
                          onChange={(role) => setRole(member, role)}
                          labels={ROLE_LABELS}
                          descriptions={ROLE_DESCRIPTIONS}
                        />
                      )
                    }
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

          {state === 'ready' && isOwner && people.pending?.length > 0 && (
            <section aria-label="Invited but not signed up">
              <h3 className="people__heading">Invited, no account yet</h3>
              <ul className="people__list">
                {people.pending.map((person) => (
                  <PersonRow
                    key={person.email}
                    name={person.email}
                    detail="Waiting for them to sign up with this address"
                    tag={person.role}
                    muted
                    action={{
                      label: 'Withdraw',
                      icon: 'close',
                      title: 'Stop expecting this address',
                      loading: pending === 'invite:' + person.email,
                      onClick: () => cancelInvite(person.email),
                    }}
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
              hint={INVITE_HINT}
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
