import { useAuth } from '../auth/useAuth.js'
import { useRoomPeople } from '../hooks/useRoomPeople.js'
import { formatWhen, roomLabel } from '../lib/rooms.js'
import { InviteForm, PersonRow } from './PeopleList.jsx'
import { Modal } from './ui/Modal.jsx'
import { Button } from './ui/Button.jsx'
import { Icon } from './ui/Icon.jsx'
import { Skeleton } from './ui/Skeleton.jsx'

function PeopleSkeleton() {
  return (
    <div className="people__list" aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <div className="people__list" key={row} style={{ padding: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Skeleton variant="circle" width={30} height={30} />
            <Skeleton width={`${45 + row * 12}%`} />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Who can reach a room, and who actually has.
 *
 * "Members" are the owner plus anyone invited; "Opened this room" is drawn
 * from real visits, so it includes guests who never had an account. The owner
 * also gets the controls: invite by email, put somebody out, let them back.
 */
export function RoomPeopleDialog({ room, open, onClose }) {
  const { user } = useAuth()
  const { state, people, error, pending, invite, remove, allow, cancelInvite } = useRoomPeople(room?.roomId, {
    enabled: open && Boolean(room),
  })

  const isOwner = Boolean(room?.owner && user?.id && room.owner === user.id)

  return (
    <Modal
      open={open}
      title={room ? 'People in ' + roomLabel(room) : 'People'}
      description={room ? 'Room ' + room.roomId : undefined}
      onClose={onClose}
      wide
    >
      {state === 'loading' && <PeopleSkeleton />}

      {state === 'error' && (
        <div className="banner banner--error" role="alert">
          <Icon name="alert" size={15} className="banner__icon" />
          <span>{error}</span>
        </div>
      )}

      {state === 'ready' && people && (
        <div className="people">
          <section>
            <h3 className="people__heading">Members</h3>
            <ul className="people__list">
              {people.members.map((member) => (
                <PersonRow
                  key={member.id}
                  name={member.name}
                  detail={member.email}
                  tag={member.role}
                  action={
                    isOwner && member.id !== room.owner
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
              {people.members.length === 0 && (
                <li className="muted people__empty">Nobody has been invited yet.</li>
              )}
            </ul>
          </section>

          {isOwner && (
            <section>
              <h3 className="people__heading">Invite someone</h3>
              <InviteForm
                onInvite={invite}
                pending={pending === 'invite'}
                hint="We email them the room code and a link straight to this room. If they have no account yet, they are asked to sign up with that address and the room is waiting when they do."
              />
            </section>
          )}

          {isOwner && people.pending?.length > 0 && (
            <section>
              <h3 className="people__heading">Invited, no account yet</h3>
              <ul className="people__list">
                {people.pending.map((person) => (
                  <PersonRow
                    key={person.email}
                    name={person.email}
                    detail={'Invited ' + formatWhen(person.at) + ' · waiting for them to sign up'}
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

          {isOwner && people.blocked?.length > 0 && (
            <section>
              <h3 className="people__heading">Removed</h3>
              <ul className="people__list">
                {people.blocked.map((person) => (
                  <PersonRow
                    key={person.id}
                    name={person.name}
                    detail={person.email + ' · removed ' + formatWhen(person.at)}
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

          <section>
            <h3 className="people__heading">Opened this room</h3>
            <ul className="people__list">
              {people.participants.map((person) => (
                <PersonRow
                  key={person.id}
                  name={person.name}
                  muted={person.guest}
                  tag={person.guest ? 'guest' : null}
                  detail={
                    person.visits +
                    ' visit' +
                    (person.visits === 1 ? '' : 's') +
                    ' · last ' +
                    formatWhen(person.lastSeenAt)
                  }
                  action={
                    isOwner && person.userId && person.userId !== room.owner
                      ? {
                          label: 'Remove',
                          icon: 'close',
                          title: 'Withdraw their access to this room',
                          loading: pending === person.userId,
                          onClick: () => remove({ id: person.userId, name: person.name }),
                        }
                      : null
                  }
                />
              ))}
              {people.participants.length === 0 && (
                <li className="muted people__empty">Nobody has opened this room yet.</li>
              )}
            </ul>
          </section>
        </div>
      )}

      <div className="modal__actions">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  )
}
