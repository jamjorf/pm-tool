import { defineConfig } from 'vitest/config';

// Every test file opens its own in-memory SQLite database (see test/helpers.ts), so no global setup is needed.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
