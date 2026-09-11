import { memo, useState } from 'react'
import { colorFor } from '../../lib/identity.js'
import { formatWhen } from '../../lib/rooms.js'
import { anchorIcon, anchorLabel, mentionSegments } from '../../lib/comments.js'
import { Button } from '../ui/Button.jsx'
import { Icon } from '../ui/Icon.jsx'
import { CommentComposer } from './CommentComposer.jsx'

function MessageBody({ message, nameOf }) {
  if (message.deleted) return <p className="thread__body thread__body--deleted">This comment was deleted.</p>

  const names = (message.mentions ?? []).map(nameOf)
  return (
    <p className="thread__body">
      {mentionSegments(message.body, names).map((segment, index) =>
        segment.mention ? (
          <span key={index} className="thread__mention">
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </p>
  )
}

/**
 * One conversation, attached to one thing.
 *
 * The anchor leads, as a button: a comment is always about something, and the
 * quickest way to understand it is to look at what it is about. Clicking it
 * takes the room there — the line in the editor, the shape on the board, the
 * file in the files panel.
 *
 * When the thing is gone the thread says so rather than pretending: a range of
 * code that has been deleted shows the snippet it was about, and a pin whose
 * shape was deleted stays where the shape last was.
 */
function CommentThreadBase({
  thread,
  userId,
  canWrite,
  canModerate,
  people,
  nameOf,
  active,
  location,
  onFocus,
  onReply,
  onResolve,
  onEdit,
  onDelete,
}) {
  const [editing, setEditing] = useState(null)
  const resolved = thread.status === 'resolved'
  const label = anchorLabel(thread.anchor, location)

  return (
    <article
      className={'thread' + (resolved ? ' thread--resolved' : '') + (active ? ' is-active' : '')}
      data-thread={thread.id}
      aria-label={'Comment on ' + label}
    >
      <header className="thread__head">
        <button
          type="button"
          className="thread__anchor"
          onClick={() => onFocus(thread)}
          aria-label={'Go to ' + label}
          title={'Go to ' + label}
        >
          <Icon name={anchorIcon(thread.anchor)} size={13} />
          <span>{label}</span>
        </button>

        {resolved && <span className="pill pill--quiet">Resolved</span>}

        {canWrite && !thread.pending && (
          <Button
            size="sm"
            variant="ghost"
            icon={resolved ? 'redo' : 'check'}
            onClick={() => onResolve(thread.id, !resolved)}
          >
            {resolved ? 'Reopen' : 'Resolve'}
          </Button>
        )}
      </header>

      {location?.orphaned && (
        <p className="thread__note muted">
          The code this was about has been removed.
          {thread.anchor.snippet && <code className="thread__snippet">{thread.anchor.snippet}</code>}
        </p>
      )}
      {location?.detached && (
        <p className="thread__note muted">The shape this was on has been deleted; the pin stays where it was.</p>
      )}
      {!location?.orphaned && thread.anchor.kind === 'code' && thread.anchor.snippet && (
        <code className="thread__snippet">{thread.anchor.snippet}</code>
      )}

      <ol className="thread__messages">
        {thread.messages.map((message) => {
          const mine = message.author === userId
          const mayDelete = !message.deleted && !message.pending && (mine || canModerate)
          const mayEdit = !message.deleted && !message.pending && mine && canWrite

          return (
            <li key={message.id} className={'thread__message' + (message.pending ? ' is-pending' : '')}>
              <span
                className="thread__avatar"
                style={{ '--identity': colorFor(message.author) }}
                aria-hidden="true"
              >
                {String(message.authorName || '?').slice(0, 1).toUpperCase()}
              </span>

              <div className="thread__main">
                <div className="thread__meta">
                  <strong className="thread__author">{message.authorName || 'Someone'}</strong>
                  <time
                    className="muted nums"
                    dateTime={message.createdAt}
                    title={new Date(message.createdAt).toLocaleString()}
                  >
                    {message.pending ? 'Sending…' : formatWhen(message.createdAt)}
                  </time>
                  {message.editedAt && !message.deleted && <span className="muted">(edited)</span>}
                </div>

                {editing === message.id ? (
                  <CommentComposer
                    people={people}
                    initialText={message.body}
                    submitLabel="Save"
                    label="Edit comment"
                    autoFocus
                    onCancel={() => setEditing(null)}
                    onSubmit={async (value) => {
                      setEditing(null)
                      return onEdit(thread.id, message.id, value)
                    }}
                  />
                ) : (
                  <MessageBody message={message} nameOf={nameOf} />
                )}

                {(mayEdit || mayDelete) && editing !== message.id && (
                  <div className="thread__tools">
                    {mayEdit && (
                      <button type="button" className="thread__tool" onClick={() => setEditing(message.id)}>
                        Edit
                      </button>
                    )}
                    {mayDelete && (
                      <button
                        type="button"
                        className="thread__tool thread__tool--danger"
                        onClick={() => onDelete(thread.id, message.id)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {canWrite && !thread.pending && !resolved && (
        <CommentComposer
          people={people}
          submitLabel="Reply"
          placeholder="Reply…"
          label={'Reply to the comment on ' + label}
          onSubmit={(value) => onReply(thread.id, value)}
        />
      )}
    </article>
  )
}

export const CommentThread = memo(CommentThreadBase)
