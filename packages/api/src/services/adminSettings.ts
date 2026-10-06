/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { PAYG_START_THRESHOLDS_KEY } from './bill2/settingKeys';
import { REPORT_SETTING } from './report/contract';
import { PAYMENT_CHANNEL_KEY } from './payments/channelSettings';
import { PAYG_HOST_SETTING } from './runtime/paygHostPolicy';
import { RUNTIME_RATE_LIMIT_KEY } from './runtime/rateLimitSettings';
import { PURPOSE_BUDGET_KEY } from './runtime/purposeBudgets';
import { PROVIDER_PRICES_KEY } from './billingProviderPrices';
import { ABSORB_CONFIG_KEY, ABSORB_ACK_KEY } from './bill2PlatformAlerts';

// Dedicated readers own these values and their validation, including serialized JSON.
const dedicatedSettingKeys = new Set([
  PAYMENT_CHANNEL_KEY, PAYG_HOST_SETTING, REPORT_SETTING, RUNTIME_RATE_LIMIT_KEY, PURPOSE_BUDGET_KEY,
  PROVIDER_PRICES_KEY, ABSORB_CONFIG_KEY, ABSORB_ACK_KEY, PAYG_START_THRESHOLDS_KEY,
]);

export const adminSettingsRowSchema = z.object({
  key: z.string().trim().min(1),
  value: z.union([z.string(), z.number().finite(), z.boolean()]),
}).passthrough();

export function genericAdminSettingsRows<T extends { key: string }>(rows: T[] | null) {
  return rows?.filter(row => !dedicatedSettingKeys.has(row?.key)) ?? rows;
}
