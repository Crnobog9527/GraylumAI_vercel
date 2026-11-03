import { expect, test } from '@playwright/test';

import { resetSim, seed, waitForHydratedForm } from './support';

/**
 * The login form is on the page long before its scripts have taken it over. A click in that gap submits the form natively (the page
 * goes to /login?, nothing is signed in): the 402 journey failed that way on CI (2026-11-03). The journeys' sign-in waits for the
 * scripts to take over the form (waitForHydratedForm). Here the page's scripts are held back so that gap is wide open: the wait must
 * stay pending until they arrive, and the sign-in that follows it must work.
 */
test.beforeEach(resetSim);

test('the sign-in waits for the page scripts to take over the form, however late they arrive', async ({ page }) => {
  const user = seed().users.bob;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname.startsWith('/_next/static/') && url.pathname.endsWith('.js'), async route => { await held; await route.continue(); });
  await page.goto('/login', { waitUntil: 'commit' });
  // The server-rendered form is there, but nothing has taken it over (what is typed into it now would be overwritten when it is).
  await expect(page.locator('input[type="email"]').first()).toBeVisible();
  let settled = false;
  const ready = waitForHydratedForm(page).then(() => { settled = true; });
  await page.waitForTimeout(2_000);
  expect(settled, 'the wait stays pending while the scripts are held').toBe(false);

  release();
  await ready;
  expect(settled).toBe(true);
  await page.locator('input[type="email"]').first().fill(user.email);
  await page.locator('input[type="password"]').first().fill(user.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 60_000 });
});
