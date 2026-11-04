import { type Page } from '@playwright/test';

import { expect, test } from './fixtures';

import { resetSim, seed, waitForHydratedForm } from './support';

/**
 * The login and forgot-password forms are server-rendered: they are on the page, filled and clicked, long before the page's scripts have
 * taken them over (CI, 2026-11-03: a click in that gap submitted the login form natively and nothing was signed in). With the page's
 * scripts held back this gap is wide open. Then:
 *  - the submit button is off and says 加载中...: clicking it (even forced) or pressing Enter in a field goes nowhere;
 *  - a native submit, forced with form.submit(), never puts what was typed into the address (the forms post, and no field has a name);
 *  - once the scripts arrive the form works.
 */
test.beforeEach(resetSim);

const SECRET = 'typed-before-the-scripts-9f3a7c';

/** Holds back every script of the app until `release()`. */
async function holdScripts(page: Page) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname.startsWith('/_next/static/') && url.pathname.endsWith('.js'), async route => { await held; await route.continue(); });
  return release;
}

const path = (page: Page) => page.url().replace(/^https?:\/\/[^/]+/, '');

/** Everything the gap must not allow, on the page that is currently open (scripts held): returns after a forced native submit. */
async function expectNothingSubmittable(page: Page, field: string) {
  const start = path(page);
  const startSearch = new URL(page.url()).search;
  const submit = page.locator('button[type="submit"]').first();
  await expect(submit).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText('加载中...');
  await page.locator(field).first().fill(SECRET);
  await submit.click({ force: true });
  await page.locator(field).first().press('Enter');
  await page.waitForTimeout(1_500);
  expect(path(page), 'a click and Enter go nowhere').toBe(start);
  // The worst case: the form is submitted natively anyway. What was typed must not reach the address.
  await page.evaluate(() => document.querySelector('form')?.submit());
  await page.waitForLoadState('domcontentloaded');
  expect(page.url(), 'what was typed is not in the address').not.toContain(SECRET);
  expect(new URL(page.url()).search, 'the query string is what it was: nothing was added').toBe(startSearch);
}

test('login: the submit button is off until the scripts have taken the form over, a native submit leaks nothing, then it signs in', async ({ page }) => {
  const user = seed().users.bob;
  const release = await holdScripts(page);
  await page.goto('/login', { waitUntil: 'commit' });
  await expectNothingSubmittable(page, 'input[type="password"]');

  release();
  await page.goto('/login');
  await waitForHydratedForm(page);
  const submit = page.locator('button[type="submit"]').first();
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveText('登录');
  await page.locator('input[type="email"]').first().fill(user.email);
  await page.locator('input[type="password"]').first().fill(user.password);
  await submit.click();
  await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 60_000 });
});

test('sign-up and forgot-password: the same gap is closed', async ({ page }) => {
  const release = await holdScripts(page);
  await page.goto('/login?action=signup', { waitUntil: 'commit' });
  await expectNothingSubmittable(page, 'input[type="password"]');
  await page.goto('/forgot-password', { waitUntil: 'commit' });
  await expectNothingSubmittable(page, 'input[type="email"]');

  release();
  await page.goto('/forgot-password');
  await waitForHydratedForm(page);
  await expect(page.locator('button[type="submit"]').first()).toBeEnabled();
  await expect(page.locator('button[type="submit"]').first()).not.toHaveText('加载中...');
});
