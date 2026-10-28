import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * CORE-PATH-V2 V2-11: the six user journeys against a deployed staging site. These make real (paid) model
 * calls, so they run on their own: one worker, in order, with a spend cap enforced by tests/e2e/core-path/support/spend.ts.
 * Required env: PLAYWRIGHT_BASE_URL and the CORE_E2E_* accounts (see tests/e2e/core-path/README.md).
 */
export default defineConfig({
  testDir: './tests/e2e/core-path',
  testMatch: /.*\.(spec|setup)\.ts/,
  outputDir: 'test-results/core-path/artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/core-path/report.json' }],
    ['html', { open: 'never', outputFolder: 'test-results/core-path/html' }],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    // A stuck click must fail in half a minute, not eat the whole journey budget.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [
    { name: 'core-setup', testMatch: /.*\.setup\.ts/, use: { trace: 'off', screenshot: 'off', video: 'off' } },
    { name: 'core-path', testMatch: /.*\.spec\.ts/, dependencies: ['core-setup'] },
  ],
  // The default 30 s is far too short for a model turn; each journey sets its own budget with test.setTimeout.
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  globalTeardown: path.resolve(__dirname, 'tests/e2e/core-path/support/teardown.ts'),
});
