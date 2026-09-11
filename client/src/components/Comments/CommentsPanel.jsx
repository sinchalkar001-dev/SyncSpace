import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDismissable } from '../../hooks/useDismissable.js'
import { anchorLabel } from '../../lib/comments.js'
import { Button } from '../ui/Button.jsx'
import { Icon } from '../ui/Icon.jsx'
import { Segmented } from '../ui/Segmented.jsx'
import { Spinner } from '../ui/Spinner.jsx'
import { CommentComposer } from './CommentComposer.jsx'
import { CommentThread } from './CommentThread.jsx'

/**
 * The room's comments, and the indicator that says there is something new.
 *
 * The button in the header carries the notification: a count of messages from
 * other people since this person last opened the panel, and an @ when one of
 * them mentions them — the thing worth interrupting somebody for. Opening the
 * panel is reading it, so the count clears as it opens.
 *
 * A new comment starts somewhere else — the comment tool on the board, the
 * Comment action in the editor, a file's Comment button — and arrives here as
 * a draft with its anchor already chosen. The panel is where it is written,
 * because it is where the rest of the conversation is.
 */
export function CommentsPanel({
  comments,
  open,
  onOpenChange,
  userId,
  signedIn,
  canWrite,
  canModerate,
  draft,
  onDraftDone,
  activeId,
  locate,
  onFocusThread,
}) {
  const containerRef = useRef(null)
  const triggerRef = useRef(null)
  const listRef = useRef(null)
  const [filter, setFilter] = useState('open')

  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  useDismissable(open, close, { containerRef, triggerRef, captureEscape: true })

  const { threads, unread, people, state, markSeen } = comments

  // Opening the panel is reading it, and so is having it open while something arrives.
  const hasUnread = unread.count > 0
  useEffect(() => {
    if (open && state === 'ready' && hasUnread) markSeen()
  }, [open, state, hasUnread, markSeen])

  // A thread asked for from somewhere else is shown whatever the filter said.
  const activeThread = threads.find((thread) => thread.id === activeId)
  useEffect(() => {
    if (!activeThread) return
    setFilter((current) =>
      current === 'all' || (current === 'resolved') === (activeThread.status === 'resolved')
        ? current
        : 'all'
    )
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector('[data-thread="' + activeThread.id + '"]')
        ?.scrollIntoView?.({ block: 'nearest' })
    )
  }, [activeThread])

  const counts = useMemo(
    () => ({
      open: threads.filter((thread) => thread.status === 'open').length,
      resolved: threads.filter((thread) => thread.status === 'resolved').length,
    }),
    [threads]
  )

  const shown = useMemo(
    () => (filter === 'all' ? threads : threads.filter((thread) => thread.status === filter)),
    [threads, filter]
  )

  // Includes this person, so a mention of them is highlighted too.
  const names = useMemo(
    () => comments.names ?? new Map(people.map((person) => [person.id, person.name])),
    [comments.names, people]
  )
  const nameOf = useCallback((id) => names.get(id) ?? null, [names])

  const label =
    'Comments' +
    (unread.count > 0 ? ' (' + unread.count + ' new' + (unread.mentions > 0 ? ', ' + unread.mentions + ' mentioning you' : '') + ')' : '')

  const refusal = !signedIn
    ? 'Sign in to comment.'
    : !canWrite
      ? 'Your role in this room can read comments but not write them.'
      : null

  return (
    <div className="presence-menu" ref={containerRef}>
      <button
        type="button"
        className="presence-menu__trigger"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={label}
        onClick={() => onOpenChange(!open)}
        ref={triggerRef}
      >
        <Icon name="comment" size={16} />
        {unread.count > 0 && (
          <span className={'comments__badge' + (unread.mentions > 0 ? ' comments__badge--mention' : '')}>
            {unread.mentions > 0 ? '@' : unread.count > 9 ? '9+' : unread.count}
          </span>
        )}
      </button>

      {open && (
        <div className="presence-menu__panel comments" role="dialog" aria-label="Comments">
          <header className="comments__head">
            <h2 className="comments__title">Comments</h2>
            <Segmented
              size="sm"
              label="Which comments"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'open', label: 'Open', count: counts.open },
                { value: 'resolved', label: 'Resolved', count: counts.resolved },
                { value: 'all', label: 'All' },
              ]}
            />
          </header>

          {draft && (
            <section className="comments__draft" aria-label="New comment">
              <p className="comments__draft-on">
                <Icon name="comment" size={13} />
                New comment on <strong>{anchorLabel(draft)}</strong>
              </p>
              {refusal ? (
                <p className="muted comments__note">{refusal}</p>
              ) : (
                <CommentComposer
                  people={people}
                  autoFocus
                  label="New comment"
                  onCancel={onDraftDone}
                  onSubmit={async (value) => {
                    onDraftDone()
                    const thread = await comments.create({ anchor: draft, ...value })
                    return Boolean(thread)
                  }}
                />
              )}
            </section>
          )}

          {state === 'loading' && (
            <div className="comments__status" role="status">
              <Spinner /> Loading comments…
            </div>
          )}

          {state === 'error' && (
            <div className="banner banner--error" role="alert">
              <Icon name="alert" size={15} className="banner__icon" />
              <span>{comments.error}</span>
              <Button size="sm" onClick={() => comments.reload()}>
                Retry
              </Button>
            </div>
          )}

          {state === 'ready' && shown.length === 0 && !draft && (
            <p className="muted comments__note">
              {threads.length === 0
                ? canWrite
                  ? 'No comments yet. Use the comment tool on the board, select code and choose Comment, or comment on a file.'
                  : 'No comments yet.'
                : filter === 'open'
                  ? 'Nothing open. Every thread has been resolved.'
                  : 'Nothing resolved yet.'}
            </p>
          )}

          {state === 'ready' && shown.length > 0 && (
            <div className="comments__list" ref={listRef}>
              {shown.map((thread) => (
                <CommentThread
                  key={thread.id}
                  thread={thread}
                  userId={userId}
                  canWrite={canWrite}
                  canModerate={canModerate}
                  people={people}
                  nameOf={nameOf}
                  active={thread.id === activeId}
                  location={locate?.(thread)}
                  onFocus={onFocusThread}
                  onReply={comments.reply}
                  onResolve={comments.setResolved}
                  onEdit={comments.edit}
                  onDelete={comments.remove}
                />
              ))}
            </div>
          )}

          {refusal && !draft && state === 'ready' && <p className="muted comments__note">{refusal}</p>}
        </div>
      )}
    </div>
  )
}
