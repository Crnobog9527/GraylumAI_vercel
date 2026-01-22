import { test as setup, expect } from '@playwright/test';
import path from 'path';

const authFile = path.join(__dirname, '../.auth/user.json');

/**
 * Authentication Setup
 * Saves authenticated state for reuse in other tests
 */
setup('authenticate', async ({ page }) => {
  // Skip if no test credentials configured
  const testEmail = process.env.E2E_TEST_EMAIL;
  const testPassword = process.env.E2E_TEST_PASSWORD;

  if (!testEmail || !testPassword) {
    console.log('Skipping auth setup: E2E_TEST_EMAIL and E2E_TEST_PASSWORD not configured');
    return;
  }

  // Go to login page
  await page.goto('/login');

  // Fill in credentials
  await page.fill('input[type="email"], input[name="email"]', testEmail);
  await page.fill('input[type="password"], input[name="password"]', testPassword);

  // Submit form
  await page.click('button[type="submit"]');

  // Wait for navigation to complete (should redirect to home or chat)
  await page.waitForURL(/\/(chat|home)?$/);

  // Verify we're logged in (check for user menu or credits display)
  await expect(
    page.locator('[data-testid="user-menu"], .credits-balance, [class*="avatar"]').first()
  ).toBeVisible({ timeout: 10000 });

  // Save authentication state
  await page.context().storageState({ path: authFile });
});
