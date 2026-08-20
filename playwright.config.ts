import { defineConfig } from '@playwright/test'

/**
 * The suite drives a real Helium browser with the unpacked MV3 extension. It runs in Chromium's
 * new headless (see `launchHelium`), but still cannot run in parallel against a single fixture
 * port, so workers are pinned to 1.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { trace: 'retain-on-failure' },
})
