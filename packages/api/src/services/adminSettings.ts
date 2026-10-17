/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { FUSION_SETTINGS_KEY } from './fusion/settings';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { PAYG_START_THRESHOLDS_KEY } from './bill2/settingKeys';
import { REPORT_SETTING } from './report/contract';
import { PAYMENT_CHANNEL_KEY } from './payments/channelSettings';
import { PAYMENT_METHOD_ROUTES_KEY } from './payments/methodRouting';
import { PAYG_HOST_SETTING, PAYG_PRODUCTION_SETTING, paygHostSettingWrite, paygProductionSettingWrite,
  RUNTIME_ENVIRONMENT_SETTING } from './runtime/paygHostPolicy';
import { RUNTIME_RATE_LIMIT_KEY } from './runtime/rateLimitSettings';
import { PURPOSE_BUDGET_KEY } from './runtime/purposeBudgets';
import { STOP_LOSS_KEY } from './runtime/stopLossSettings';
import { PROVIDER_PRICES_KEY } from './billingProviderPrices';
import { ABSORB_CONFIG_KEY, ABSORB_ACK_KEY } from './bill2PlatformAlerts';
import { MODEL_IDENTITY_GUARD_KEY } from './modelIdentity/guardSetting';

// Dedicated readers own these values and their validation, including serialized JSON.
const dedicatedSettingKeys = new Set([
  PAYMENT_CHANNEL_KEY, PAYG_HOST_SETTING, PAYG_PRODUCTION_SETTING, RUNTIME_ENVIRONMENT_SETTING, REPORT_SETTING, RUNTIME_RATE_LIMIT_KEY, PURPOSE_BUDGET_KEY,
  PROVIDER_PRICES_KEY, ABSORB_CONFIG_KEY, ABSORB_ACK_KEY, PAYG_START_THRESHOLDS_KEY, STOP_LOSS_KEY,
  MODEL_IDENTITY_GUARD_KEY, PAYMENT_METHOD_ROUTES_KEY, FUSION_SETTINGS_KEY,
  // Read by methodPayments checkout; the settings page has no field for it.
  'payment_terms_version',
]);

export const adminSettingsRowSchema = z.object({
  key: z.string().trim().min(1),
  value: z.union([z.string(), z.number().finite(), z.boolean()]),
}).passthrough();

// The settings page edits scalars only; an unlisted structured row is skipped (and logged) rather
// than failing the whole page. Null and malformed scalar rows still fail the scalar validation.
function isStructuredValue(value: unknown) {
  return typeof value === 'object' && value !== null;
}

export function genericAdminSettingsRows<T extends { key: string; value?: unknown }>(rows: T[] | null) {
  return rows?.filter(row => {
    if (dedicatedSettingKeys.has(row?.key)) return false;
    if (!isStructuredValue(row?.value)) return true;
    logger.warn('api', 'admin_settings_unknown_structured_key_skipped', { key: row.key });
    return false;
  }) ?? rows;
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
  if (setting.key === PAYG_PRODUCTION_SETTING && !paygProductionSettingWrite.safeParse(setting.value).success) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '正式 PAYG 设置须为有效对象，关闭可保存 {enabled:false}' });
  }
  if (setting.key === RUNTIME_ENVIRONMENT_SETTING) {
    ctx.addIssue({ code: 'custom', path: ['key'], message: '正式库标记只能由上线批准的数据库操作写入' });
  }
  if (setting.key === PAYG_START_THRESHOLDS_KEY && !paygStartThresholdsSchema.safeParse(setting.value).success) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '启动门槛须含版本、唯一模型和用途，以及美元十进制字符串' });
  }
}
