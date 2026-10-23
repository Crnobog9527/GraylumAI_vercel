/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { isAllowedHttpsUrl } from '../../src/lib/safe-url';
import { expect, test } from '@playwright/test';
import { authStatePaths } from './support/auth';
import { gotoWithBypass } from './support/deploymentProtection';
import { openMethodCheckoutDialog, payInMethodCheckoutDialog, settledPackBuyButton } from './support/methodCheckout';

test.describe('production-only stripe smoke', () => {
  const productionBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? '';
  const isProductionTarget = isAllowedHttpsUrl(productionBaseUrl, [
    'https://graylum.com', 'https://www.graylum.com',
  ]);

  test.skip(!isProductionTarget, 'Production-only Stripe smoke.');

  test('public login page remains reachable on production', async ({ page }) => {
    await gotoWithBypass(page, '/login');
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    await expect(page.locator('form').getByRole('button', { name: /^登录$|^Login$/i })).toBeVisible();
  });

  test('webhook rejects invalid signatures on production', async ({ request }) => {
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

    test('credit package purchase redirects to Stripe Checkout for a paid member', async ({ page }) => {
      await gotoWithBypass(page, '/app/profile?tab=subscription');

      await expect(page.getByRole('heading', { name: '积分加油包' })).toBeVisible();

      // Packs are for paid members only; the buy button stays disabled for anyone else.
      const buyButton = await settledPackBuyButton(page);
      test.skip(await buyButton.isDisabled(), 'The smoke user cannot buy a credit package.');

      const dialog = await openMethodCheckoutDialog(page, buyButton);
      const response = await payInMethodCheckoutDialog(page, dialog);
      expect(response.status()).toBe(200);

      await page.waitForURL(/(checkout|buy)\.stripe\.com/, { timeout: 20000 });
      await expect(page).toHaveURL(/(checkout|buy)\.stripe\.com/);
    });

    test('membership plan purchase redirects to Stripe Checkout for a normal user', async ({ page }) => {
      await gotoWithBypass(page, '/app/profile?tab=subscription');

      await expect(page.getByRole('heading', { name: '会员订阅' })).toBeVisible();

      const targetPlan = page.locator('[data-testid="profile-membership-plan-gold"]');
      await expect(targetPlan).toBeVisible();

      const dialog = await openMethodCheckoutDialog(page, targetPlan.getByRole('button').last());
      const response = await payInMethodCheckoutDialog(page, dialog);
      expect(response.status()).toBe(200);

      await page.waitForURL(/(checkout|buy)\.stripe\.com/, { timeout: 20000 });
      await expect(page).toHaveURL(/(checkout|buy)\.stripe\.com/);
    });
  });
});
