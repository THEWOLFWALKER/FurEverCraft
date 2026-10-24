import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * Real headless browser E2E for the local control surface.
 *
 * Each spec starts its own Fastify server process with an isolated port, temporary SQLite
 * database and temporary build/web root, then drives the built React app through Chromium.
 * No screenshots, video or traces are captured: the assertions are DOM/service behaviour.
 *
 * A missing browser or a failed server startup fails the run: there is deliberately no
 * not-run/fallback path here (the old constant-success stub is gone).
 */
export default defineConfig({
  testDir: fileURLToPath(new URL('./tests/e2e', import.meta.url)),
  testMatch: /.*\.spec\.ts$/,
  outputDir: fileURLToPath(new URL('./tests/e2e/.playwright-results', import.meta.url)),
  fullyParallel: false,
  // One server/browser pair at a time keeps ports, DB files and process cleanup bounded.
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    headless: true,
    screenshot: 'off',
    video: 'off',
    trace: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], headless: true },
    },
  ],
});
