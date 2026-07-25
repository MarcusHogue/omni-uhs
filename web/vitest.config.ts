import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['test/e2e/**'],
    environment: 'node',
    environmentMatchGlobs: [['test/ui/**', 'jsdom']],
  },
});
