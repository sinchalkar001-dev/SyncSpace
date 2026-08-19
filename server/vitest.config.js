import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Each DB-backed file boots its own mongod; keep them from competing.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ALLOW_ANONYMOUS: 'true',
      PERSIST_UPDATE_LOG: 'true',
      PERSIST_DEBOUNCE_MS: '50',
      PERSIST_MAX_DEBOUNCE_MS: '200',
    },
  },
})
