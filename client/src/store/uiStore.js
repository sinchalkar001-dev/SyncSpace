import { create } from 'zustand'

export const TOOLS = [
  'select',
  'hand',
  'pen',
  'segment',
  'arrow',
  'rect',
  'diamond',
  'ellipse',
  'text',
  'eraser',
]

export const STROKE_COLORS = [
  '#e2e8f0',
  '#f97316',
  '#22d3ee',
  '#a78bfa',
  '#4ade80',
  '#f472b6',
  '#facc15',
]

const MIN_SCALE = 0.2
const MAX_SCALE = 4

/**
 * Local-only UI state. Nothing here is shared — anything collaborative
 * lives in the Yjs document instead.
 */
const WORKSPACE_KEY = 'syncspace:workspace'

/**
 * Workspace preferences that should outlive a reload: how the panes are
 * split, which pane is showing, and the editor's own display options.
 * Everything else in this store is per-session and deliberately not stored.
 */
function loadWorkspace() {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveWorkspace(state) {
  try {
    localStorage.setItem(
      WORKSPACE_KEY,
      JSON.stringify({
        splitRatio: state.splitRatio,
        paneMode: state.paneMode,
        language: state.language,
        recentLanguages: state.recentLanguages,
        editor: state.editor,
      })
    )
  } catch {
    // Storage can be unavailable; preferences then last for this tab only.
  }
}

const saved = loadWorkspace()

export const useUIStore = create((set) => ({
  tool: 'pen',
  strokeColor: STROKE_COLORS[1],
  strokeWidth: 3,
  fontSize: 20,
  language: saved.language || 'javascript',
  recentLanguages: saved.recentLanguages || [],
  splitRatio: saved.splitRatio ?? 0.5,
  // 'split' shows both panes; 'board' and 'code' give one the whole room.
  paneMode: saved.paneMode || 'split',
  editor: {
    minimap: false,
    wordWrap: false,
    fontSize: 13.5,
    ...(saved.editor || {}),
  },
  viewport: { scale: 1, x: 0, y: 0 },

  setTool: (tool) => set({ tool }),
  setStrokeColor: (strokeColor) => set({ strokeColor }),
  setStrokeWidth: (strokeWidth) => set({ strokeWidth }),
  setFontSize: (fontSize) => set({ fontSize }),
  setLanguage: (language) =>
    set((state) => {
      const recentLanguages = [language, ...state.recentLanguages.filter((n) => n !== language)]
      const next = { language, recentLanguages: recentLanguages.slice(0, 5) }
      saveWorkspace({ ...state, ...next })
      return next
    }),

  setSplitRatio: (splitRatio) =>
    set((state) => {
      const next = { splitRatio: Math.min(0.85, Math.max(0.15, splitRatio)) }
      saveWorkspace({ ...state, ...next })
      return next
    }),

  setPaneMode: (paneMode) =>
    set((state) => {
      saveWorkspace({ ...state, paneMode })
      return { paneMode }
    }),

  toggleEditorOption: (key) =>
    set((state) => {
      const editor = { ...state.editor, [key]: !state.editor[key] }
      saveWorkspace({ ...state, editor })
      return { editor }
    }),

  setEditorOption: (key, value) =>
    set((state) => {
      const editor = { ...state.editor, [key]: value }
      saveWorkspace({ ...state, editor })
      return { editor }
    }),

  /**
   * Accepts a value or an updater, the way React's setState does.
   *
   * Both call sites on the board pass an updater, because a pan and a zoom are
   * both defined relative to where the view already is. Taking only a value
   * meant `set({ viewport: <the function> })`: the viewport became the updater
   * itself, so `viewport.scale` and `viewport.x` were undefined from the first
   * wheel or drag onwards, and the board snapped back to the origin and stayed
   * there.
   */
  setViewport: (next) =>
    set((state) => ({ viewport: typeof next === 'function' ? next(state.viewport) : next })),
  zoomBy: (factor) =>
    set((state) => ({
      viewport: {
        ...state.viewport,
        scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.viewport.scale * factor)),
      },
    })),
  resetViewport: () => set({ viewport: { scale: 1, x: 0, y: 0 } }),
}))

export { MIN_SCALE, MAX_SCALE }
