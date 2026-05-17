import { defineConfig } from 'vitest/config';

/**
 * Default vitest config — unit tests only. Integration tests
 * (`test/integration/**`) are excluded here so `npm test` stays hermetic.
 * Run them explicitly with `npm run test:integration`.
 */
export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules/**', 'dist/**'],
  },
});
