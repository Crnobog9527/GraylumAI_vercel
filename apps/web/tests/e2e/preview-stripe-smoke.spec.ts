/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, test } from '@playwright/test';
import { authStatePaths } from './support/auth';
import { gotoWithBypass } from './support/deploymentProtection';

test.describe('preview-only stripe smoke', () => {
  const previewBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? '';
  const isHostedPreviewTarget =
    previewBaseUrl.includes('vercel.app') || previewBaseUrl.includes('staging.graylum.com');

  test.skip(!isHostedPreviewTarget, 'Preview-only Stripe smoke.');

  test('public login page remains reachable on preview', async ({ page }) => {
    await gotoWithBypass(page, '/login');
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    await expect(page.locator('form').getByRole('button', { name: /^登录$|^Login$/i })).toBeVisible();
  });

  test('webhook rejects invalid signatures on preview', async ({ request }) => {
    const response = await request.post('/api/stripe/webhook', {
      data: '{}',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'invalid-signature',
      },
    });

    expect(response.status()).toBe(400);
  });

  test.describe('authenticated checkout smoke', () => {
    test.use({ storageState: authStatePaths.user });

    test('credit package purchase redirects to Stripe Checkout for a normal user', async ({ page }) => {
      await gotoWithBypass(page, '/profile?tab=subscription');

      await expect(page.getByRole('heading', { name: '积分加油包' })).toBeVisible();

      const responsePromise = page.waitForResponse((response) =>
        response.url().includes('/api/trpc/payments.createCheckoutSession'),
      );

      await page.getByRole('button', { name: '购买' }).click();

      const response = await responsePromise;
      expect(response.status()).toBe(200);

      await page.waitForURL(/(checkout|buy)\.stripe\.com/, { timeout: 20000 });
      await expect(page).toHaveURL(/(checkout|buy)\.stripe\.com/);
    });
  });
});
