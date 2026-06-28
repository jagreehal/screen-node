import { defineConfig } from 'vitest/config';

// Integration: golden CLI tests (need the built dist/) + Docker tests (need a
// running container runtime; they self-skip if none is found). Slow — opt-in.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
