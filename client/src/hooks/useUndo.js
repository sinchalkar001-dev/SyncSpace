import { useCallback, useEffect, useState } from 'react'

/** Tracks a Y.UndoManager so the toolbar can enable and disable its buttons. */
export function useUndo(undoManager) {
  const [state, setState] = useState({ canUndo: false, canRedo: false })

  useEffect(() => {
    if (!undoManager) return undefined

    const read = () =>
      setState({
        canUndo: undoManager.undoStack.length > 0,
        canRedo: undoManager.redoStack.length > 0,
      })

    read()
    undoManager.on('stack-item-added', read)
    undoManager.on('stack-item-popped', read)
    undoManager.on('stack-cleared', read)

    return () => {
      undoManager.off('stack-item-added', read)
      undoManager.off('stack-item-popped', read)
      undoManager.off('stack-cleared', read)
    }
  }, [undoManager])

  const undo = useCallback(() => undoManager?.undo(), [undoManager])
  const redo = useCallback(() => undoManager?.redo(), [undoManager])

  return { ...state, undo, redo }
}
