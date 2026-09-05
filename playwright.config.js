import { defineConfig, devices } from '@playwright/test'

const CLIENT = 'http://localhost:5180'

/**
 * End-to-end tests drive two real browser tabs against the real stack, so both
 * servers must be up. The backend runs against an ephemeral in-process
 * MongoDB, so no local mongod is needed; a server already listening on 4000 is
 * reused as-is.
 *
 * The registration limiter is raised for this run only. At its production
 * default of five per fifteen minutes, a second full run inside that window
 * fails at sign-up — and the failures surface much later, as missing rooms and
 * error toasts covering the thing a test was about to click.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.js',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  /**
   * One retry on CI, none locally. These drive two real browsers against two
   * real servers, so a timing loss is not the same event as a broken feature —
   * but a test that needs the retry every time is one to fix, and the run
   * summary says which ones used it.
   */
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: CLIENT,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev:memory --workspace server',
      url: 'http://127.0.0.1:4000/health',
      reuseExistingServer: true,
      timeout: 120000,
      env: {
        AUTH_RATE_LIMIT_REGISTER_MAX: '500',
        AUTH_RATE_LIMIT_LOGIN_MAX: '500',
        // The suite runs the client on 5180, not the 5173 the server allows by
        // default. Vite proxies the API and the sockets but forwards the
        // browser's Origin as it is, so the collab upgrade is refused without
        // this and every room test fails at "Connected".
        CORS_ORIGIN: CLIENT,
      },
    },
    {
      command: 'npm run dev --workspace client -- --port 5180 --strictPort',
      url: CLIENT,
      reuseExistingServer: true,
      timeout: 120000,
    },
  ],
})
