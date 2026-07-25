import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The cache tests bind real sockets and write to disk; keep them serial so
    // temp directories and ports never collide.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
