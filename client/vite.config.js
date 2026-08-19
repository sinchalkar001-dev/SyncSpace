import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The backend (Express + Hocuspocus + Socket.io) is expected on one HTTP server.
// Dev requests are proxied so the client can use same-origin relative paths.
const BACKEND = process.env.VITE_BACKEND_ORIGIN || 'http://localhost:4000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/collab': { target: BACKEND, ws: true, changeOrigin: true },
      '/socket.io': { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: {
    // Monaco ships a lot of code; keep it in its own chunk instead of one huge bundle.
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor'],
          konva: ['konva', 'react-konva'],
          yjs: ['yjs', '@hocuspocus/provider', 'y-monaco'],
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
    restoreMocks: true,
  },
})
