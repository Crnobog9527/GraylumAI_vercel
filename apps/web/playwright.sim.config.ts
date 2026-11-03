import { defineConfig, devices } from '@playwright/test';

/**
 * Layer 1 of the three-layer validation (Owner 2026-11-03): the core-path journeys against a local app, a disposable local database
 * and a deterministic simulated model (no paid call). Started by scripts/e2e-sim/run.mjs, which provides SIM_BASE_URL and the rest;
 * the default `playwright test` does not run these.
 */
export default defineConfig({
  testDir: './tests/e2e/sim',
  testMatch: /.*\.spec\.ts/,
  outputDir: 'test-results/sim/artifacts',
  // One local app and one database: journeys run one after another, each on its own account where balances matter.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['json', { outputFile: 'test-results/sim/report.json' }]],
  use: {
    baseURL: process.env.SIM_BASE_URL,
    actionTimeout: 30_000,
    // The development server compiles a route on its first visit.
    navigationTimeout: 120_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  timeout: 4 * 60_000,
  expect: { timeout: 20_000 },
});
