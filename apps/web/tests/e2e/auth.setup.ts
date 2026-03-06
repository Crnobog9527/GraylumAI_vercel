import { test as setup, expect, type Page } from '@playwright/test';
import {
  authStatePaths,
  ensureAuthStateDirectory,
  getCredentials,
  hasCredentials,
  type E2ERole,
} from './support/auth';

/**
 * Authentication Setup
 * Saves authenticated state for reuse in other tests
 */
async function saveEmptyState(page: Page, authFile: string) {
  await page.context().storageState({ path: authFile });
}

async function authenticateRole(page: Page, role: E2ERole) {
  const credentials = getCredentials(role);

  if (!credentials.email || !credentials.password) {
    console.log(`Skipping ${role} auth setup: missing credentials`);
    await saveEmptyState(page, authStatePaths[role]);
    return;
  }

  await page.goto('/login');

  await page.fill('#email, input[type="email"], input[name="email"]', credentials.email);
  await page.fill('#password, input[type="password"], input[name="password"]', credentials.password);
  await page.getByRole('button', { name: 'Login' }).click();

  await page.waitForFunction(() => window.location.pathname !== '/login', undefined, { timeout: 15000 });

  if (role === 'admin') {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin/);
  } else {
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/profile/);
  }

  await page.context().storageState({ path: authStatePaths[role] });
}

setup('authenticate user', async ({ page }) => {
  await ensureAuthStateDirectory();
  if (!hasCredentials('user')) {
    await saveEmptyState(page, authStatePaths.user);
    return;
  }
  await authenticateRole(page, 'user');
});

setup('authenticate admin', async ({ page }) => {
  await ensureAuthStateDirectory();
  if (!hasCredentials('admin')) {
    await saveEmptyState(page, authStatePaths.admin);
    return;
  }
  await authenticateRole(page, 'admin');
});
