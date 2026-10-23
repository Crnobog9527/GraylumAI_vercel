/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The current purchase flow: a buy button opens the method-checkout dialog; ticking the terms and pressing pay
 * calls `payments.methodCheckout`, which answers with the payment provider's address.
 */
export async function openMethodCheckoutDialog(page: Page, buyButton: Locator) {
  await buyButton.click();
  const dialog = page.getByTestId('method-checkout-dialog');
  await expect(dialog).toBeVisible({ timeout: 10000 });
  return dialog;
}

/** Ticks the terms and pays; returns the `payments.methodCheckout` response. */
export async function payInMethodCheckoutDialog(page: Page, dialog: Locator) {
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/api/trpc/payments.methodCheckout') && response.request().method() === 'POST',
  );
  await dialog.getByTestId('method-checkout-terms').check();
  await dialog.getByTestId('method-checkout-pay').click();
  return responsePromise;
}
