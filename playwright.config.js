import { defineConfig, devices } from '@playwright/test'

const CLIENT = 'http://localhost:5180'
const MODEL_STUB = 'http://127.0.0.1:4100'

/**
 * End-to-end tests drive two real browser tabs against the real stack, so both
 * servers must be up. The backend runs against an ephemeral in-process
 * MongoDB, so no local mongod is needed; a server already listening on 4000 is
 * reused as-is.
 *
 * The credential limiters are raised for this run only. At the production
 * default of five per fifteen minutes, a second full run inside that window
 * fails at sign-up — and the failures surface much later, as missing rooms and
 * error toasts covering the thing a test was about to click. Password recovery
 * has the same shape and the same trap: every request in the suite arrives
 * from one address.
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
      // Started before the backend, which is pointed at it. Waited on by port
      // rather than by URL: this one only answers /v1/messages, and a health
      // check against its root is a 404, which `url` would treat as not ready.
      command: 'node e2e/fixtures/model-stub.js',
      port: 4100,
      reuseExistingServer: true,
      timeout: 30000,
    },
    {
      command: 'npm run dev:memory --workspace server',
      url: 'http://127.0.0.1:4000/health',
      reuseExistingServer: true,
      timeout: 120000,
      env: {
        /**
         * The whole-API budget, not just the credential ones.
         *
         * Every request in the suite arrives from one address, and the
         * production default of 300 per fifteen minutes is spent somewhere
         * around the fiftieth test — after which everything fails with "Too
         * many requests", including tests that have nothing to do with rate
         * limiting. It surfaces as sign-ups that hang rather than as anything
         * naming a limit, which is what makes it worth pinning here.
         */
        RATE_LIMIT_MAX: '5000',
        INVITE_RATE_LIMIT_MAX: '500',
        RUN_RATE_LIMIT_MAX: '500',

        AUTH_RATE_LIMIT_REGISTER_MAX: '500',
        AUTH_RATE_LIMIT_LOGIN_MAX: '500',
        AUTH_RATE_LIMIT_FORGOT_MAX: '500',
        AUTH_RATE_LIMIT_RESET_MAX: '500',
        AUTH_RATE_LIMIT_PASSWORD_CHANGE_MAX: '500',
        AI_RATE_LIMIT_MAX: '500',
        COMMENT_RATE_LIMIT_MAX: '500',
        /**
         * Generation is pointed at a local stand-in for the Messages API (see
         * e2e/fixtures/model-stub.js), so the whole path is exercised — the
         * graph read off the board, the prompt, the answer parsed back, the
         * refusals, the review and the apply — without a key, a bill, or a
         * suite whose result depends on what a model felt like writing.
         *
         * The key is deliberately non-empty: the stub refuses a request
         * without one, so forgetting to send it fails here rather than
         * passing quietly.
         */
        // A deliberate fake, shaped like a real key so the provider is
        // inferred correctly. The stub is the only thing it ever reaches.
        ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-credential', // secret-scan: allow
        AI_BASE_URL: MODEL_STUB,
        AI_ENABLED: 'true',
        // The suite runs the client on 5180, not the 5173 the server allows by
        // default. Vite proxies the API and the sockets but forwards the
        // browser's Origin as it is, so the collab upgrade is refused without
        // this and every room test fails at "Connected".
        CORS_ORIGIN: CLIENT,

        /**
         * Compose every message, send none of them.
         *
         * This server runs in development mode, so it reads server/.env —
         * which on a machine with working credentials means the suite would
         * mail dozens of invented addresses through a real Gmail account, and
         * collect the bounces. The unit suite is protected by NODE_ENV=test
         * skipping dotenv entirely; this is the same protection for the one
         * suite that cannot use it.
         */
        EMAIL_PROVIDER: 'mock',

        /**
         * Which sandbox runs the programs, pinned rather than discovered.
         *
         * On `auto` this depends on whether the machine has a container
         * runtime, and CI runners ship with one — so the suite ran against
         * containers there and child processes here. Worse, the images had
         * never been pulled, which turns each run into a silent download
         * against a five-second budget and fails as a timeout with nothing in
         * the message about images.
         *
         * Pinned to the same backend everywhere, so a red run means the
         * feature broke rather than that the host was different. What a real
         * container does is checked by the flags in the server suite, and by
         * `npm run sandbox:check` on a machine that has one.
         */
        SANDBOX_BACKEND: 'process',
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
