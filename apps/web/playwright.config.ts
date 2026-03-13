import path from 'node:path';

import dotenv from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

dotenv.config({
  path: path.resolve(__dirname, '../../.env.local'),
});

const remoteBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const shouldUseLocalWebServer = !process.env.CI && !remoteBaseUrl;

/**
 * Playwright E2E Test Configuration
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  // Test directory
  testDir: './tests/e2e',

  // Keep structured reports and per-test evidence under a stable directory
  outputDir: 'test-results/artifacts',

  // Run tests in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Opt out of parallel tests on CI
  workers: process.env.CI ? 1 : undefined,

  // Reporter to use
  reporter: [
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/report.json' }],
    ['list'],
  ],

  // Shared settings for all projects
  use: {
    // Base URL for navigation
    baseURL: remoteBaseUrl || 'http://localhost:3000',

    // Keep trace artifacts for any failing flow audit in local runs
    trace: 'retain-on-failure',

    // Take screenshot on failure
    screenshot: 'only-on-failure',

    // Record video on failure
    video: 'retain-on-failure',
  },

  // Configure projects for major browsers
  projects: [
    // Setup project for authentication
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      use: {
        trace: 'off',
        screenshot: 'off',
        video: 'off',
      },
    },

    // Desktop Chrome
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
      dependencies: ['setup'],
    },

    // Desktop Firefox (optional, uncomment if needed)
    // {
    //   name: 'firefox',
    //   use: {
    //     ...devices['Desktop Firefox'],
    //   },
    //   dependencies: ['setup'],
    // },

    // Mobile Chrome
    {
      name: 'mobile-chrome',
      use: {
        ...devices['Pixel 5'],
      },
      dependencies: ['setup'],
    },
  ],

  // Run local dev server before starting the tests
  webServer: shouldUseLocalWebServer
    ? {
        command: 'pnpm dev',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
      }
    : undefined,

  // Global timeout for each test
  timeout: 30000,

  // Expect timeout
  expect: {
    timeout: 10000,
  },
});
