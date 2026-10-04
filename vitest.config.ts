import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The bridge is stateful and spawns real (fake-query) processes; keep it serial.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
