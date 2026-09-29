/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { defineConfig, devices } from '@playwright/test';

const LOCAL_NEXT_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'local-balance-test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'local-balance-test-service-role-key',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3127',
  VERCEL_ENV: 'development',
  NEXT_TELEMETRY_DISABLED: '1',
} satisfies Record<string, string>;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'chat-balance-unavailable.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/balance-unavailable-artifacts',
  use: {
    baseURL: 'http://localhost:3127',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: [
    {
      command: 'node tests/e2e/support/balance-supabase-stub.mjs',
      url: 'http://127.0.0.1:54321/health',
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      // Real local rate limiting; unavailable Redis still rejects requests.
      command: 'node ../../packages/db/tests/v3/run-with-local-rate-limit.mjs pnpm exec next dev --webpack -p 3127',
      url: 'http://localhost:3127',
      env: LOCAL_NEXT_ENV,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
});
