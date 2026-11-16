/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test, expect } from '@playwright/test';
import { authStatePaths } from './support/auth';
import { createIssueMonitor } from './support/monitoring';

test('canonical home, callback and protected routes over HTTP', async ({ request }) => {
  const old = await request.get('/landing?domain=www&source=test', { maxRedirects: 0 });
  expect(old.status()).toBe(308);
  const target = new URL(old.headers().location, old.url());
  expect(target.pathname).toBe('/');
  expect(target.searchParams.get('domain')).toBe('www');
  expect(target.searchParams.get('source')).toBe('test');
  const home = await request.get(target.toString(), { maxRedirects: 0 });
  expect(home.status()).toBe(200);
  const rsc = await request.get('/?_rsc=route-test', {
    maxRedirects: 0, headers: { RSC: '1', 'Next-Router-Prefetch': '1' },
  });
  expect(rsc.status()).toBe(307);
  const rscUrl = new URL(rsc.headers().location, rsc.url());
  expect(rscUrl.pathname).toBe('/');
  const rscResult = await request.get(rscUrl.toString(), {
    maxRedirects: 0, headers: { RSC: '1', 'Next-Router-Prefetch': '1' },
  });
  expect(rscResult.status()).toBe(200);
  expect(rscResult.headers()['content-type']).toContain('text/x-component');
  const callback = await request.get('/?code=example&source=test', { maxRedirects: 0 });
  expect(callback.status()).toBe(307);
  expect(new URL(callback.headers().location, callback.url()).pathname).toBe('/auth/callback');
  const error = await request.get('/?error=access_denied', { maxRedirects: 0 });
  expect(error.status()).toBe(307);
  expect(new URL(error.headers().location, error.url()).pathname).toBe('/login');
  const protectedPage = await request.get('/app/profile?tab=security', { maxRedirects: 0 });
  expect(protectedPage.status()).toBe(307);
  expect(new URL(protectedPage.headers().location, protectedPage.url()).searchParams.get('redirect')).toBe('/app/profile?tab=security');
});

test('anonymous home renders at its canonical URL', async ({ page }) => {
  const monitor = createIssueMonitor(page);
  await page.goto('/landing?domain=www&source=test');
  await expect(page).toHaveURL(/\/\?domain=www&source=test/);
  await expect(page.getByRole('link', { name: '免费和教练聊聊' }).first()).toBeVisible();
  await expect(page.locator('div.min-h-screen').first()).toHaveCSS('background-color', 'rgb(10, 10, 10)');
  await page.waitForLoadState('networkidle');
  expect(monitor.getIssues('P1')).toEqual([]);
});

test.describe('signed-in visitor', () => {
  test.use({ storageState: authStatePaths.user });
  test('home remains available without a redirect loop', async ({ page }) => {
    await page.goto('/app/profile');
    await expect(page).toHaveURL(/\/app\/profile/);
    const monitor = createIssueMonitor(page);
    await page.goto('/?domain=www');
    await expect(page).toHaveURL(/\/\?domain=www/);
    await expect(page.getByRole('link', { name: '免费和教练聊聊' }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(monitor.getIssues('P1')).toEqual([]);
  });
});
