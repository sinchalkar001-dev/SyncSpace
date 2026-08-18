import { Group, Path, Rect, Text } from 'react-konva'

const POINTER_PATH = 'M0 0 L0 15 L4.2 11.4 L6.9 17.4 L9.4 16.2 L6.7 10.4 L12 10 Z'

/**
 * Peer cursors live on their own non-interactive layer and are drawn at a
 * fixed screen size, so they stay legible at any zoom level.
 */
export function RemoteCursors({ peers, scale }) {
  const inverse = 1 / (scale || 1)

  return peers
    .filter((peer) => peer.cursor && peer.user)
    .map((peer) => {
      const label = peer.user.name || 'Guest'
      const width = label.length * 6.6 + 14

      return (
        <Group
          key={peer.clientId}
          x={peer.cursor.x}
          y={peer.cursor.y}
          scaleX={inverse}
          scaleY={inverse}
          listening={false}
        >
          <Path data={POINTER_PATH} fill={peer.user.color} stroke="#0b1120" strokeWidth={1} />
          <Rect x={14} y={12} width={width} height={20} cornerRadius={4} fill={peer.user.color} />
          <Text
            x={14}
            y={12}
            width={width}
            height={20}
            text={label}
            fontSize={11}
            fontFamily="'Inter', system-ui, sans-serif"
            fill="#0b1120"
            align="center"
            verticalAlign="middle"
          />
        </Group>
      )
    })
}
