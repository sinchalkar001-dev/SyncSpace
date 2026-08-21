import { create } from 'zustand'

export const TOOLS = [
  'select',
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
export const useUIStore = create((set) => ({
  tool: 'pen',
  strokeColor: STROKE_COLORS[1],
  strokeWidth: 3,
  fontSize: 20,
  language: 'javascript',
  splitRatio: 0.5,
  viewport: { scale: 1, x: 0, y: 0 },

  setTool: (tool) => set({ tool }),
  setStrokeColor: (strokeColor) => set({ strokeColor }),
  setStrokeWidth: (strokeWidth) => set({ strokeWidth }),
  setFontSize: (fontSize) => set({ fontSize }),
  setLanguage: (language) => set({ language }),
  setSplitRatio: (splitRatio) => set({ splitRatio: Math.min(0.85, Math.max(0.15, splitRatio)) }),

  setViewport: (viewport) => set({ viewport }),
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
