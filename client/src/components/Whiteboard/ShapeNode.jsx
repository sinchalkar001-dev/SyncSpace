import { Arrow, Ellipse, Line, Rect, Text } from 'react-konva'

/** Diamond points, relative to the shape's own origin. */
function diamondPoints(width, height) {
  return [width / 2, 0, width, height / 2, width / 2, height, 0, height / 2]
}

/** Renders one shared shape. Geometry always comes from the Yjs document. */
export function ShapeNode({
  shape,
  draggable,
  isSelected,
  onPointerDown,
  onDragEnd,
  onHoverStart,
  onHoverEnd,
}) {
  const common = {
    id: shape.id,
    x: shape.x || 0,
    y: shape.y || 0,
    draggable,
    onPointerDown: (event) => onPointerDown(event, shape),
    onDragEnd: (event) => onDragEnd(shape.id, { x: event.target.x(), y: event.target.y() }),
    onMouseEnter: (event) => onHoverStart?.(event, shape),
    onMouseLeave: () => onHoverEnd?.(),
    stroke: shape.stroke,
    strokeWidth: shape.strokeWidth,
    shadowColor: '#f2a03f',
    shadowBlur: isSelected ? 14 : 0,
    shadowOpacity: isSelected ? 0.9 : 0,
  }

  // Thin geometry is hard to hit exactly; widen the hit area, never the paint.
  const hitStrokeWidth = Math.max(shape.strokeWidth * 3, 12)

  switch (shape.type) {
    case 'line':
      return (
        <Line
          {...common}
          points={shape.points}
          tension={0.35}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={hitStrokeWidth}
        />
      )
    case 'segment':
      return (
        <Line {...common} points={shape.points} lineCap="round" hitStrokeWidth={hitStrokeWidth} />
      )
    case 'arrow':
      return (
        <Arrow
          {...common}
          points={shape.points}
          fill={shape.stroke}
          pointerLength={Math.max(shape.strokeWidth * 3, 10)}
          pointerWidth={Math.max(shape.strokeWidth * 3, 10)}
          lineCap="round"
          hitStrokeWidth={hitStrokeWidth}
        />
      )
    case 'rect':
      return <Rect {...common} width={shape.width} height={shape.height} cornerRadius={4} />
    case 'diamond':
      return (
        <Line
          {...common}
          points={diamondPoints(shape.width, shape.height)}
          closed
          lineJoin="round"
          hitStrokeWidth={hitStrokeWidth}
        />
      )
    case 'ellipse':
      return <Ellipse {...common} radiusX={shape.radiusX} radiusY={shape.radiusY} />
    case 'text':
      return (
        <Text
          {...common}
          text={shape.text}
          fontSize={shape.fontSize}
          fontFamily="'IBM Plex Sans', system-ui, sans-serif"
          fill={shape.stroke}
          strokeEnabled={false}
        />
      )
    default:
      return null
  }
}
