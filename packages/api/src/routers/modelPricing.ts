/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc';
import { createSafeInternalError } from '../lib/publicError';
import { logger } from '../lib/logger';
import {
  BillingUnitConfigError, parseOptionalMultiplier, readBillingUnitSettings, type BillingUnitSettings,
} from '../services/billingUnit';
import { providerPricesView, saveProviderPrices } from '../services/billingProviderPrices';

function providerPricesError(cause: unknown): TRPCError {
  const code = cause instanceof BillingUnitConfigError ? cause.code : null;
  if (code === 'BILLING_UNIT_PROVIDER_PRICES_INVALID') {
    return new TRPCError({ code: 'BAD_REQUEST', message: '第三方价格配置不合法，请检查后再保存', cause });
  }
  if (code === 'BILLING_UNIT_PROVIDER_PRICES_CONFLICT') {
    return new TRPCError({ code: 'CONFLICT', message: '第三方价格配置已被别人修改，请刷新后再保存', cause });
  }
  logger.warn('billing', 'provider_prices_unavailable', { code: code ?? 'unknown' });
  return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '无法读取或保存第三方价格配置，请稍后重试', cause });
}

// BILL-UNIT: admin-only view and edit of the per-model price multiplier (ai_models.price_multiplier).
// Reads go through the service-role client; the column has no anon/authenticated grant.
type MultiplierRow = { id: string; name: string; model_id: string; is_active: string; price_multiplier: unknown; updated_at: string };

export type ModelMultiplierView = {
  id: string;
  name: string;
  modelId: string;
  isActive: boolean;
  override: string | null;
  effective: string | null;
  source: 'model' | 'global' | 'invalid';
  updatedAt: string;
};

function viewRow(row: MultiplierRow, site: BillingUnitSettings | null): ModelMultiplierView {
  let override: string | null = null;
  let invalid = false;
  try { override = parseOptionalMultiplier(row.price_multiplier); } catch { invalid = true; }
  const base = { id: row.id, name: row.name, modelId: row.model_id, isActive: row.is_active === 'true', updatedAt: row.updated_at };
  if (invalid) return { ...base, override: null, effective: null, source: 'invalid' };
  if (override !== null) return { ...base, override, effective: override, source: 'model' };
  return { ...base, override: null, effective: site?.defaultMultiplier ?? null, source: 'global' };
}

const setMultiplierInput = z.object({
  modelId: z.string().uuid(),
  priceMultiplier: z.string().max(16).nullable(),
  expectedUpdatedAt: z.string().min(1).max(64),
}).strict();

export const modelPricingRouter = router({
  getMultipliers: adminProcedure.query(async ({ ctx }) => {
    let site: BillingUnitSettings | null = null;
    try { site = await readBillingUnitSettings(ctx.supabase); } catch (cause) {
      logger.warn('billing', 'billing_unit_settings_unavailable', { code: cause instanceof BillingUnitConfigError ? cause.code : 'unknown' });
    }
    const { data, error } = await ctx.supabase.from('ai_models')
      .select('id, name, model_id, is_active, price_multiplier, updated_at').order('name');
    // A missing column (migration not applied) or read failure disables editing; it is never shown as "inherit".
    if (error || !Array.isArray(data)) {
      logger.warn('billing', 'model_price_multiplier_read_failed', { code: error?.code ?? 'not_array' });
      return { site, available: false as const, models: [] as ModelMultiplierView[] };
    }
    return { site, available: true as const, models: (data as MultiplierRow[]).map((row) => viewRow(row, site)) };
  }),

  getProviderPrices: adminProcedure.query(async ({ ctx }) => {
    try { return await providerPricesView(ctx.supabase); } catch (cause) { throw providerPricesError(cause); }
  }),

  setProviderPrices: adminProcedure
    .input(z.object({ expectedHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(), config: z.unknown() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const saved = await saveProviderPrices(ctx.supabase, input.config, input.expectedHash);
        logger.info('billing', 'provider_prices_updated', { profileId: ctx.profileId, entries: saved.config.entries.length, hash: saved.hash });
        return saved;
      } catch (cause) { throw providerPricesError(cause); }
    }),

  setMultiplier: adminProcedure.input(setMultiplierInput).mutation(async ({ ctx, input }) => {
    let value: string | null;
    try {
      value = parseOptionalMultiplier(input.priceMultiplier === '' ? null : input.priceMultiplier);
    } catch {
      throw new TRPCError({ code: 'BAD_REQUEST', message: '加价倍数须在 1 到 20 之间，最多两位小数；留空表示使用全站默认值' });
    }
    const { data, error } = await ctx.supabase.from('ai_models')
      .update({ price_multiplier: value, updated_at: new Date().toISOString() })
      .eq('id', input.modelId).eq('updated_at', input.expectedUpdatedAt)
      .select('id, price_multiplier, updated_at');
    if (error) throw createSafeInternalError(error, '保存加价倍数失败，请稍后重试');
    if (!Array.isArray(data) || data.length !== 1) {
      throw new TRPCError({ code: 'CONFLICT', message: '模型配置已被别人修改或已删除，请刷新后再保存' });
    }
    const saved = data[0] as { id: string; price_multiplier: unknown; updated_at: string };
    let readBack: string | null | undefined;
    try { readBack = parseOptionalMultiplier(saved.price_multiplier); } catch { readBack = undefined; }
    if (readBack !== value) {
      throw createSafeInternalError(new Error('price_multiplier read-back mismatch'), '保存后读回的加价倍数不一致，请刷新后核对');
    }
    logger.info('billing', 'model_price_multiplier_updated', {
      profileId: ctx.profileId, modelId: saved.id, priceMultiplier: readBack, updatedAt: saved.updated_at,
    });
    return { modelId: saved.id, priceMultiplier: readBack, updatedAt: saved.updated_at };
  }),
});
