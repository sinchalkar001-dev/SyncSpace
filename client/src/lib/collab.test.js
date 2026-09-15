import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { pushShape, pushShapes, removeShapes, updateShape } from './collab.js'

const board = () => {
  const doc = new Y.Doc()
  return { doc, shapes: doc.getArray('shapes') }
}

const ids = (shapes) => shapes.toJSON().map((shape) => shape.id)

/** How many updates the document emitted — each is a message to the room and a row in its log. */
function updatesDuring(doc, change) {
  let count = 0
  const counted = () => {
    count += 1
  }
  doc.on('update', counted)
  change()
  doc.off('update', counted)
  return count
}

describe('pushShapes', () => {
  it('adds several shapes as one change', () => {
    const { doc, shapes } = board()

    const count = updatesDuring(doc, () => pushShapes(shapes, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]))

    expect(count).toBe(1)
    expect(ids(shapes)).toEqual(['a', 'b', 'c'])
  })
})

describe('removeShapes', () => {
  it('removes several shapes as one change', () => {
    const { doc, shapes } = board()
    pushShapes(shapes, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }])

    let removed
    const count = updatesDuring(doc, () => {
      removed = removeShapes(shapes, ['a', 'c', 'd'])
    })

    expect(count).toBe(1)
    expect(ids(shapes)).toEqual(['b'])
    expect([...removed].sort()).toEqual(['a', 'c', 'd'])
  })

  /** The Delete key and the eraser used to remove a locked shape the action bar would not. */
  it('leaves a locked shape where it is', () => {
    const { shapes } = board()
    pushShape(shapes, { id: 'a' })
    pushShape(shapes, { id: 'b' })
    updateShape(shapes, 'b', { locked: true })

    expect(removeShapes(shapes, ['a', 'b'])).toEqual(['a'])
    expect(ids(shapes)).toEqual(['b'])
  })

  it('ignores ids the board does not have', () => {
    const { shapes } = board()
    pushShape(shapes, { id: 'a' })

    expect(removeShapes(shapes, ['missing'])).toEqual([])
    expect(ids(shapes)).toEqual(['a'])
  })
})
