import { defineConfig, devices } from '@playwright/test';

// ANALYTICS-CONSENT: the local app has no visitor country, so it counts as an opt-in region and shows the statistics consent bar until
// the visitor chooses. Journeys start as a visitor who already accepted (like one outside Europe); 12-consent-bar.spec.ts clears this to
// test the bar itself. Contexts a journey makes itself get the same choice from tests/e2e/sim/fixtures.ts.
const CONSENT_CHOICE = { name: 'graylum.analytics.consent', value: JSON.stringify({ choice: 'granted', at: '2026-11-07T00:00:00.000Z' }) };
const storageState = process.env.SIM_BASE_URL
  ? { cookies: [], origins: [{ origin: new URL(process.env.SIM_BASE_URL).origin, localStorage: [CONSENT_CHOICE] }] }
  : undefined;

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
    storageState,
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
