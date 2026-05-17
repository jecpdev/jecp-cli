import { defineConfig } from 'vitest/config';

/**
 * Integration vitest config — opt-in via `npm run test:integration`.
 *
 * Spawns the built CLI (`dist/cli.js`) as a child process and asserts
 * against the live JECP Hub at `JECP_TEST_BASE_URL` (default
 * `https://setsuna-jobdonebot.fly.dev`).
 *
 * IMPORTANT: requires `npm run build` first — these tests run the
 * compiled artifact, not the TS source.
 *
 * The default `test/setup.ts` is intentionally NOT loaded here: it mocks
 * `node:os` `homedir()` inside the test process, but integration tests
 * spawn child processes that have their own homedir. We sandbox the
 * child's HOME via env vars passed at spawn time instead (see each
 * integration test file).
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 45_000,
    hookTimeout: 45_000,
    sequence: { concurrent: false },
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
