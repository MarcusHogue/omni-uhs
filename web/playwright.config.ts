import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the local Compose stack, not the Vite dev
 * server: the offline test needs the real service worker and the real cache
 * headers, and `vite dev` ships neither.
 *
 *   docker compose -f docker-compose.local.yml up -d --build
 *   npm run test:e2e --workspace web
 */
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:8081',
    trace: 'retain-on-failure',
  },
  /**
   * Chromium at phone size, not WebKit.
   *
   * The service worker, IndexedDB and reveal logic are engine-independent, so
   * this proves the offline path; what it cannot prove is Safari-specific
   * behaviour (Add to Home Screen, the 7-day eviction exemption). Those stay a
   * manual check on a real iPhone — see the README.
   */
  projects: [
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: false,
        hasTouch: true,
        // Set PW_CHROMIUM_PATH when the machine already has a Chromium that
        // Playwright did not download itself (CI images, sandboxes).
        ...(process.env['PW_CHROMIUM_PATH']
          ? { launchOptions: { executablePath: process.env['PW_CHROMIUM_PATH'] } }
          : {}),
      },
    },
  ],
});
