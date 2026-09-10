import { memo, useMemo } from 'react'
import { Group, Rect, Text } from 'react-konva'
import { shapeBounds } from '../../lib/hitTest.js'

/**
 * The shapes other people have selected, outlined in their colour.
 *
 * The point is to stop two people editing the same box at once without knowing
 * it. A dashed outline with a name is enough to see that somebody else has hold
 * of something, and quiet enough not to be mistaken for your own selection,
 * which is solid and glows.
 *
 * Drawn from ids alone. A peer sends which shapes it has selected, never their
 * contents, so this resolves each id against the board everybody already
 * shares — and a peer that has turned sharing off sends no ids at all.
 */
function RemoteSelectionsBase({ peers, shapes, scale }) {
  const byId = useMemo(() => {
    const map = new Map()
    for (const shape of shapes) if (shape?.id) map.set(shape.id, shape)
    return map
  }, [shapes])

  const inverse = 1 / (scale || 1)
  const pad = 5 * inverse
  const outlines = []

  for (const peer of peers) {
    const ids = peer.presence?.share ? peer.presence.selected : null
    if (!ids?.length || !peer.user) continue

    const color = peer.user.color || '#22d3ee'
    let labelled = false

    for (const id of ids) {
      const bounds = shapeBounds(byId.get(id))
      if (!bounds) continue

      outlines.push(
        <Group key={peer.clientId + ':' + id} listening={false}>
          <Rect
            x={bounds.x - pad}
            y={bounds.y - pad}
            width={bounds.width + pad * 2}
            height={bounds.height + pad * 2}
            stroke={color}
            strokeWidth={1.5 * inverse}
            dash={[6 * inverse, 4 * inverse]}
            cornerRadius={4 * inverse}
          />
          {/* One name per person, on the first of their shapes, rather than a
              label on every shape in a multi-selection. */}
          {!labelled && (
            <Text
              x={bounds.x - pad}
              y={bounds.y - pad - 15 * inverse}
              text={peer.user.name || 'Guest'}
              fontSize={10.5 * inverse}
              fontStyle="bold"
              fontFamily="'Inter', system-ui, sans-serif"
              fill={color}
            />
          )}
        </Group>
      )
      labelled = true
    }
  }

  return outlines
}

export const RemoteSelections = memo(RemoteSelectionsBase)
