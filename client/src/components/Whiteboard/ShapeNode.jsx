import { Ellipse, Line, Rect, Text } from 'react-konva'

/** Renders one shared shape. Geometry always comes from the Yjs document. */
export function ShapeNode({ shape, draggable, isSelected, onPointerDown, onDragEnd }) {
  const common = {
    x: shape.x || 0,
    y: shape.y || 0,
    draggable,
    onPointerDown: (event) => onPointerDown(event, shape),
    onDragEnd: (event) => onDragEnd(shape.id, { x: event.target.x(), y: event.target.y() }),
    stroke: shape.stroke,
    strokeWidth: shape.strokeWidth,
    shadowColor: '#38bdf8',
    shadowBlur: isSelected ? 14 : 0,
    shadowOpacity: isSelected ? 0.9 : 0,
  }

  switch (shape.type) {
    case 'line':
      return (
        <Line
          {...common}
          points={shape.points}
          tension={0.35}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={Math.max(shape.strokeWidth * 3, 12)}
        />
      )
    case 'rect':
      return <Rect {...common} width={shape.width} height={shape.height} cornerRadius={4} />
    case 'ellipse':
      return <Ellipse {...common} radiusX={shape.radiusX} radiusY={shape.radiusY} />
    case 'text':
      return (
        <Text
          {...common}
          text={shape.text}
          fontSize={shape.fontSize}
          fontFamily="'Inter', system-ui, sans-serif"
          fill={shape.stroke}
          strokeEnabled={false}
        />
      )
    default:
      return null
  }
}
