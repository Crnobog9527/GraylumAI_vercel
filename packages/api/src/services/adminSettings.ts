/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { PAYG_START_THRESHOLDS_KEY } from './bill2/settingKeys';
import { REPORT_SETTING } from './report/contract';
import { PAYMENT_CHANNEL_KEY } from './payments/channelSettings';
import { PAYG_HOST_SETTING, paygHostSettingWrite } from './runtime/paygHostPolicy';
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

// Keep decimal strings exact; SQL computes L using the frozen run/call rates.
const thresholdIdentity = { model: z.string().min(1), purpose: z.string().min(1) };
const typicalThreshold = z.object({
  ...thresholdIdentity,
  typicalUsd: z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/),
}).passthrough().refine(entry => !Object.hasOwn(entry, 'credits'));
const legacyThreshold = z.object({
  ...thresholdIdentity,
  credits: z.union([z.number().int().min(1).max(999999999), z.string().regex(/^[1-9][0-9]{0,8}$/)]),
}).passthrough().refine(entry => !Object.hasOwn(entry, 'typicalUsd'));

export const paygStartThresholdsSchema = z.object({
  version: z.string().trim().min(1),
  thresholds: z.array(z.union([typicalThreshold, legacyThreshold])).min(1),
}).passthrough().refine(value => {
  const pairs = value.thresholds.map(entry => JSON.stringify([entry.model, entry.purpose]));
  return new Set(pairs).size === pairs.length;
}, '模型和用途不能重复');

export function validatePaygAdminSetting(setting: { key: string; value?: unknown }, ctx: z.RefinementCtx) {
  if (setting.key === PAYG_HOST_SETTING && !paygHostSettingWrite.safeParse(setting.value).success) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'PAYG 设置须为有效对象，关闭可保存 {enabled:false}' });
  }
  if (setting.key === PAYG_START_THRESHOLDS_KEY && !paygStartThresholdsSchema.safeParse(setting.value).success) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '启动门槛须含版本、唯一模型和用途，以及美元十进制字符串' });
  }
}
