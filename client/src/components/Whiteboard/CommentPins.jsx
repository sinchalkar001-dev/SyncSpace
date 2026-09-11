import { memo, useMemo } from 'react'
import { Circle, Group, Rect, Text } from 'react-konva'
import { resolveBoardAnchor } from '../../lib/comments.js'

const OPEN = '#f2a03f'
const RESOLVED = '#56605c'
const INK = '#0d1211'

const pointer = (cursor) => (event) => {
  const container = event.target.getStage()?.container()
  if (container) container.style.cursor = cursor
}

// A press on a pin is a press on the pin, never the start of a new comment or
// a marquee on the board underneath it.
const keepToPin = (event) => {
  event.cancelBubble = true
}

/**
 * Comment pins on the board.
 *
 * Positioned from each thread's anchor on every render, and the board renders
 * whenever a shape moves — so a pin on a shape moves with it for free, with no
 * bookkeeping of its own. A pin whose shape has been deleted stays where the
 * shape last was.
 *
 * Drawn at a fixed screen size whatever the zoom, like the remote cursors, so
 * a pin stays clickable when the board is zoomed out and does not swallow the
 * shape when it is zoomed in.
 *
 * `draft` is the comment being placed: the area being dragged out, or the
 * anchor chosen for a comment that is still being written. It is drawn hollow,
 * so it reads as "about to be here" rather than as a conversation.
 */
function CommentPinsBase({ threads, shapes, scale, activeId, draft, onOpen, interactive = true }) {
  const byId = useMemo(() => {
    const map = new Map()
    for (const shape of shapes) if (shape?.id) map.set(shape.id, shape)
    return map
  }, [shapes])

  const inverse = 1 / (scale || 1)
  const placing = draft ? resolveBoardAnchor(draft, byId) : null

  return (
    <>
      {threads.map((thread) => {
        const at = resolveBoardAnchor(thread.anchor, byId)
        if (!at) return null

        const resolved = thread.status === 'resolved'
        const active = thread.id === activeId
        const count = thread.messages.filter((message) => !message.deleted).length
        const color = resolved ? RESOLVED : OPEN
        const open = () => onOpen?.(thread.id)

        return (
          <Group key={thread.id} x={at.x} y={at.y}>
            {at.width > 0 && at.height > 0 && (
              <Rect
                width={at.width}
                height={at.height}
                stroke={color}
                strokeWidth={1.5 * inverse}
                dash={[6 * inverse, 4 * inverse]}
                opacity={active ? 1 : 0.6}
                listening={false}
              />
            )}

            <Group
              scaleX={inverse}
              scaleY={inverse}
              listening={interactive}
              onPointerDown={keepToPin}
              onClick={open}
              onTap={open}
              onMouseEnter={pointer('pointer')}
              onMouseLeave={pointer('')}
            >
              <Circle
                radius={active ? 13 : 11}
                fill={color}
                stroke={active ? '#ffffff' : INK}
                strokeWidth={2}
                shadowColor="#000"
                shadowBlur={6}
                shadowOpacity={0.35}
              />
              <Text
                x={-11}
                y={-6}
                width={22}
                align="center"
                text={count > 99 ? '99' : String(count)}
                fontSize={11}
                fontStyle="bold"
                fontFamily="'Inter', system-ui, sans-serif"
                fill={INK}
                listening={false}
              />
            </Group>
          </Group>
        )
      })}

      {placing && (
        <Group x={placing.x} y={placing.y} listening={false}>
          {placing.width > 0 && placing.height > 0 && (
            <Rect
              width={placing.width}
              height={placing.height}
              stroke={OPEN}
              strokeWidth={1.5 * inverse}
              dash={[6 * inverse, 4 * inverse]}
            />
          )}
          <Group scaleX={inverse} scaleY={inverse}>
            <Circle radius={11} fill={INK} stroke={OPEN} strokeWidth={2} dash={[4, 3]} />
            <Text x={-11} y={-7} width={22} align="center" text="+" fontSize={14} fill={OPEN} />
          </Group>
        </Group>
      )}
    </>
  )
}

export const CommentPins = memo(CommentPinsBase)
