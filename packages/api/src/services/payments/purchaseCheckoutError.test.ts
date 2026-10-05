/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { mapPurchaseCheckoutError } from './purchaseCheckoutError';
it.each(['PAY_COMMON_CHANNEL_NOT_READY', 'PAY_COMMON_LIVE_PURCHASE_DISABLED', 'PAY_COMMON_CHANNEL_SETTING_INVALID'])(
  'maps %s to unavailable product for both purchase kinds', code => {
    for (const kind of ['credit_package', 'membership_plan'] as const) {
      const error = mapPurchaseCheckoutError(new Error(code), kind);
      expect(error?.code).toBe('BAD_REQUEST');
      expect(error?.message).toContain('暂不可购买');
    }
  },
);
