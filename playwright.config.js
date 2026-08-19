import { defineConfig, devices } from '@playwright/test'

const CLIENT = 'http://localhost:5180'

/**
 * End-to-end tests drive two real browser tabs against the real stack, so both
 * servers must be up. A MongoDB on 127.0.0.1:27017 is required; without one,
 * start the backend with `npm run dev:memory --workspace server` first and
 * these will reuse it.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: CLIENT,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run start --workspace server',
      url: 'http://127.0.0.1:4000/health',
      reuseExistingServer: true,
      timeout: 60000,
    },
    {
      command: 'npm run dev --workspace client -- --port 5180 --strictPort',
      url: CLIENT,
      reuseExistingServer: true,
      timeout: 120000,
    },
  ],
})
