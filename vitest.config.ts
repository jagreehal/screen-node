import { defineConfig } from 'vitest/config';

// Default: fast unit tests only (no Docker, no build). Integration lives under
// test/integration/ and runs via `npm run test:integration`.
export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
  },
});
