import { useEffect, useRef } from 'react'
import { Group, Path, Rect, Text } from 'react-konva'
import { stepCursor } from '../../lib/presence.js'

const POINTER_PATH = 'M0 0 L0 15 L4.2 11.4 L6.9 17.4 L9.4 16.2 L6.7 10.4 L12 10 Z'

/**
 * Other people's pointers, gliding between the positions they send.
 *
 * Peers send their pointer about fifteen times a second. Drawing each sample
 * where it lands would make every cursor jump in visible steps; instead each
 * one eases toward its latest sample on every animation frame, which reads as
 * continuous motion at a fraction of the traffic.
 *
 * None of this goes through React. Positions are read straight from awareness
 * and written straight onto the Konva nodes, and the frame loop runs only
 * while a cursor is still travelling — a room where nobody is moving costs no
 * frames at all. React renders this component only when somebody joins,
 * leaves, or the board is zoomed.
 *
 * It also fixes a cursor that used to freeze: the awareness hook updates
 * pointers in place without re-rendering, so a remote cursor used to move only
 * when your own board happened to redraw. Watching somebody else draw, their
 * pointer stood still.
 */
export function RemoteCursors({ peers, scale, provider }) {
  const inverse = 1 / (scale || 1)

  const nodes = useRef(new Map())
  const shown = useRef(new Map())
  const targets = useRef(new Map())
  const wakeRef = useRef(null)

  useEffect(() => {
    const awareness = provider?.awareness
    if (!awareness) return undefined

    let frame = 0
    let last = 0

    const loop = (time) => {
      const dt = last ? time - last : 16
      last = time

      let moving = false
      let layer = null

      nodes.current.forEach((node, clientId) => {
        layer = layer || node.getLayer()
        const target = targets.current.get(clientId)

        if (!target) {
          shown.current.delete(clientId)
          if (node.visible()) node.visible(false)
          return
        }

        const next = stepCursor(shown.current.get(clientId), target, dt)
        shown.current.set(clientId, next)
        node.position({ x: next.x, y: next.y })
        if (!node.visible()) node.visible(true)
        if (!next.settled) moving = true
      })

      layer?.batchDraw()

      if (moving) {
        frame = requestAnimationFrame(loop)
      } else {
        frame = 0
        last = 0
      }
    }

    const wake = () => {
      if (!frame && typeof requestAnimationFrame === 'function') {
        frame = requestAnimationFrame(loop)
      }
    }
    wakeRef.current = wake

    const read = () => {
      const next = new Map()
      awareness.getStates().forEach((state, clientId) => {
        if (clientId !== awareness.clientID && state.user && state.cursor) {
          next.set(clientId, state.cursor)
        }
      })
      targets.current = next
      wake()
    }

    read()
    awareness.on('change', read)

    return () => {
      awareness.off('change', read)
      if (frame) cancelAnimationFrame(frame)
      wakeRef.current = null
    }
  }, [provider])

  // A newly mounted cursor needs one frame to be placed and shown.
  useEffect(() => {
    wakeRef.current?.()
  }, [peers])

  return peers
    .filter((peer) => peer.user)
    .map((peer) => {
      const label = peer.user.name || 'Guest'
      const width = label.length * 6.6 + 14

      return (
        <Group
          key={peer.clientId}
          ref={(node) => {
            if (!node) {
              nodes.current.delete(peer.clientId)
              return
            }
            // Hidden until the loop has a position for it. Only on first
            // registration: a callback ref runs on every render, and hiding
            // here every time would blink every cursor on every zoom.
            if (!shown.current.has(peer.clientId)) node.visible(false)
            nodes.current.set(peer.clientId, node)
          }}
          scaleX={inverse}
          scaleY={inverse}
          listening={false}
        >
          <Path data={POINTER_PATH} fill={peer.user.color} stroke="#0d1211" strokeWidth={1} />
          <Rect x={14} y={12} width={width} height={20} cornerRadius={4} fill={peer.user.color} />
          <Text
            x={14}
            y={12}
            width={width}
            height={20}
            text={label}
            fontSize={11}
            fontFamily="'Inter', system-ui, sans-serif"
            fill="#0d1211"
            align="center"
            verticalAlign="middle"
          />
        </Group>
      )
    })
}
