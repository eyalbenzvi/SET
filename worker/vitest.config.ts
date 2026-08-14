import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/globalSetup.ts'],
    // A real workerd process plus WebSocket round-trips needs more headroom
    // than the vitest default, and the suite must not run in parallel against
    // one shared server.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
