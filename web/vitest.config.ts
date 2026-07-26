import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Two things the app gets from Vite and its PWA plugin, which vitest runs
  // without: the build stamp, and the plugin's virtual registration module.
  define: { __APP_VERSION__: JSON.stringify('test') },
  resolve: {
    alias: {
      'virtual:pwa-register': fileURLToPath(
        new URL('./test/stubs/pwa-register.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['test/e2e/**'],
    environment: 'node',
    environmentMatchGlobs: [['test/ui/**', 'jsdom']],
  },
});
