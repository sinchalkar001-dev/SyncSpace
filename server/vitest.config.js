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
      // Pinned so a developer's own server/.env cannot reshuffle the
      // documentation endpoint out from under the docs tests.
      SWAGGER_ENABLED: 'true',
      SWAGGER_PATH: '/docs',

      /**
       * Which sandbox the suite runs against, pinned rather than discovered.
       *
       * Left on `auto` this is decided by whether the machine happens to have
       * a container runtime — which means the suite tests one thing on a
       * developer's laptop and a different thing on CI, where the runners ship
       * with Docker. That is how this landed green locally and red on CI: every
       * run there became `docker run` against images nobody had pulled, so each
       * one was a silent image download that ended as a five-second timeout.
       *
       * The container path is covered by execution-docker.test.js, which
       * asserts the argument list flag by flag without needing a daemon. What
       * a real container does with those flags is not something a test can
       * check without one, and pretending otherwise is worse than saying so.
       */
      SANDBOX_BACKEND: 'process',

      /**
       * No wait between verification emails, for every test that is not about
       * the wait.
       *
       * The cooldown is a production behaviour and a real one — it is what
       * stops the resend button being a way to mail-bomb an address. But a
       * suite that has to sit out sixty seconds to re-register is a suite
       * nobody runs, and loosening the assertions to cope would be worse.
       * The cooldown has its own tests, which set the value themselves.
       */
      EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS: '0',

      /**
       * Compose every message, send none of them.
       *
       * Without this the suite is one `.env` away from mailing real people:
       * a developer with working credentials would have several hundred
       * verification emails delivered to whatever addresses the fixtures
       * invent. The outbox still records them, so a test can read the code.
       */
      EMAIL_PROVIDER: 'mock',
    },
  },
})
