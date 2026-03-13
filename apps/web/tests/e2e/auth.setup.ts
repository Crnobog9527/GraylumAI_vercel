import { test as setup, expect, type Page } from '@playwright/test';
import {
  authStatePaths,
  ensureAuthStateDirectory,
  getCredentials,
  hasCredentials,
  type E2ERole,
} from './support/auth';
import { gotoWithBypass } from './support/deploymentProtection';

/**
 * Authentication Setup
 * Saves authenticated state for reuse in other tests
 */
setup.describe.configure({ mode: 'serial' });
setup.setTimeout(90000);

async function saveEmptyState(page: Page, authFile: string) {
  await page.context().storageState({ path: authFile });
}

function getProtectedPath(role: E2ERole) {
  return role === 'admin' ? '/admin' : '/profile';
}

async function hasSupabaseAuthCookie(page: Page) {
  const cookieScope = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
  const cookies = await page.context().cookies(cookieScope);
  return cookies.some((cookie) => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name));
}

async function submitCredentials(page: Page) {
  const submitButton = page.locator('button[type="submit"]');
  try {
    await submitButton.click({ timeout: 5000 });
  } catch {
    await page.locator('#password, input[type="password"], input[name="password"]').press('Enter');
  }
}

async function canReachProtectedPath(page: Page, role: E2ERole) {
  const targetPath = getProtectedPath(role);
  await gotoWithBypass(page, targetPath);

  const currentPath = new URL(page.url()).pathname;
  const hasAuthCookie = await hasSupabaseAuthCookie(page);
  if (role === 'admin') {
    return hasAuthCookie && currentPath.startsWith('/admin');
  }

  return hasAuthCookie && currentPath.startsWith('/profile');
}

async function waitForAuthenticatedNavigation(page: Page, role: E2ERole) {
  try {
    await page.waitForFunction(() => window.location.pathname !== '/login', undefined, { timeout: 30000 });
  } catch {
    return canReachProtectedPath(page, role);
  }

  const currentPath = new URL(page.url()).pathname;
  if (currentPath === '/verify-email') {
    return canReachProtectedPath(page, role);
  }

  if (currentPath === '/login') {
    return canReachProtectedPath(page, role);
  }

  return hasSupabaseAuthCookie(page);
}

async function authenticateRole(page: Page, role: E2ERole) {
  const credentials = getCredentials(role);

  if (!credentials.email || !credentials.password) {
    console.log(`Skipping ${role} auth setup: missing credentials`);
    await saveEmptyState(page, authStatePaths[role]);
    return;
  }

  await gotoWithBypass(page, '/login');

  await page.fill('#email, input[type="email"], input[name="email"]', credentials.email);
  await page.fill('#password, input[type="password"], input[name="password"]', credentials.password);
  await submitCredentials(page);

  let authenticated = await waitForAuthenticatedNavigation(page, role);
  if (!authenticated) {
    await gotoWithBypass(page, '/login');
    await page.fill('#email, input[type="email"], input[name="email"]', credentials.email);
    await page.fill('#password, input[type="password"], input[name="password"]', credentials.password);
    await submitCredentials(page);
    authenticated = await waitForAuthenticatedNavigation(page, role);
  }

  if (!authenticated) {
    throw new Error(`E2E ${role} login did not reach an authenticated surface after retrying.`);
  }

  if (!(await hasSupabaseAuthCookie(page))) {
    throw new Error(`E2E ${role} login did not persist a Supabase auth cookie.`);
  }

  const currentPath = new URL(page.url()).pathname;
  if (currentPath === '/verify-email') {
    throw new Error(`E2E ${role} account is not email-verified and cannot be used for authenticated setup flows.`);
  }

  const protectedPath = getProtectedPath(role);
  if (role === 'admin') {
    await gotoWithBypass(page, protectedPath);
    await expect(page).toHaveURL(/\/admin/);
  } else {
    await gotoWithBypass(page, protectedPath);
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
