import { modelCapacityView, supplierCapacityPatch } from '../shared/modelCapacityView';
import { modelPriceView } from '../shared/modelPriceView';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { router, adminProcedure } from '../trpc';
import { logger } from '../lib/logger';
import { createSafeInternalError } from '../lib/publicError';
import { readOpenRouterCatalog } from '../services/models/openRouterCatalog';
import { RUNTIME_MODEL_COLUMNS } from '../services/models/runtimeEligibility';
import { TryRefused, tryReasoning } from '../services/models/tryReasoning';
import { REASONING_PURPOSES, checkReasoningConfig, purposeSettings, readReasoningConfig, type ReasoningConfig } from '../shared/modelReasoning';
import { diffPricing, readPricingSnapshot, type PricingSnapshot } from '../shared/modelPricing';

/** Administrator reasoning settings (MODEL-REASONING) and the OpenRouter price
 * snapshot (MODEL-PRICING-SYNC). Only these procedures write
 * `ai_models.config.reasoning` and `ai_models.config.pricing`. */
/** One "try once" per model per 30 s on this server instance: a guard against
 * repeated clicks, not a spending control (each try is one short call). */
export const TRY_INTERVAL_MS = 30_000;
const lastTry = new Map<string, number>();
const modelInput = z.object({ modelId: z.string().uuid() }).strict();
const catalogMessages: Record<string, string> = {
  MODEL_CATALOG_ID_INVALID: '模型 ID 格式不受支持，无法读取目录',
  MODEL_CATALOG_NOT_FOUND: 'OpenRouter 目录里没有这个模型，请核对模型 ID',
  MODEL_CATALOG_TOO_LARGE: 'OpenRouter 目录返回的数据过大，请稍后重试',
  MODEL_CATALOG_INVALID: 'OpenRouter 目录返回的格式无法识别，没有保存；原有快照保持不变',
};

async function readModel(db: SupabaseClient, modelId: string) {
  const { data, error } = await db.from('ai_models').select('id,model_id,input_limit,max_tokens,config,updated_at').eq('id', modelId).maybeSingle();
  if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '无法读取模型配置，请稍后重试' });
  if (!data) throw new TRPCError({ code: 'NOT_FOUND', message: '模型不存在，请刷新列表' });
  return data as { id: string; model_id: string; input_limit?: number | null; max_tokens: number | null; config: unknown; updated_at: string };
}
function view(row: { model_id: string; input_limit?: number | null; max_tokens: number | null; config: unknown }) {
  const config = readReasoningConfig(row.config);
  const maxTokens = Number(row.max_tokens) || 0;
  return { model: row.model_id, maxTokens, config, capacity: modelCapacityView(row), priceView: modelPriceView(row),
    pricing: readPricingSnapshot(row.config),
    issues: checkReasoningConfig(config, { maxTokens, modelId: row.model_id }) };
}
type ModelRow = Awaited<ReturnType<typeof readModel>>;
/** Replaces only the `reasoning` key (and `pricing` when given). The update is
 * computed from the row as read right before the write and is conditional on
 * that row's `updated_at`, so a slow catalog read never writes back a config
 * that an intervening save, connection test or price read has changed. */
async function writeReasoning(
  db: SupabaseClient, modelId: string, update: (current: ReasoningConfig, row: ModelRow) => ReasoningConfig, pricing?: PricingSnapshot,
) {
  const current = await readModel(db, modelId);
  const reasoning = update(readReasoningConfig(current.config), current);
  const base = current.config && typeof current.config === 'object' && !Array.isArray(current.config) ? current.config as Record<string, unknown> : {};
  const config = { ...base, reasoning, ...(pricing ? { pricing } : {}) };
  const capacityPatch = pricing ? supplierCapacityPatch({ ...current, config }) : {};
  const { data, error } = await db.from('ai_models').update({ config, ...capacityPatch, updated_at: new Date().toISOString() })
    .eq('id', modelId).eq('updated_at', current.updated_at).select('id');
  if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '保存模型设置失败，请稍后重试' });
  if (!Array.isArray(data) || data.length !== 1) throw new TRPCError({ code: 'CONFLICT', message: '模型配置刚被修改，请重试' });
  return { row: current, view: view({ ...current, config, ...capacityPatch }) };
}

export const modelReasoningRouter = router({
  /** One real call with a fixed short question (⑥). Platform-paid, not billed through BILL2. */
  tryOnce: adminProcedure
    .input(z.object({ modelId: z.string().uuid(), purpose: z.enum(REASONING_PURPOSES) }).strict())
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase.from('ai_models').select(RUNTIME_MODEL_COLUMNS).eq('id', input.modelId).maybeSingle();
      if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '无法读取模型配置，请稍后重试' });
      if (!data) throw new TRPCError({ code: 'NOT_FOUND', message: '模型不存在，请刷新列表' });
      const now = Date.now(), previous = lastTry.get(input.modelId);
      if (previous !== undefined && now - previous < TRY_INTERVAL_MS)
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `同一个模型 ${TRY_INTERVAL_MS / 1000} 秒内只能试一次，请稍后再试` });
      try {
        lastTry.set(input.modelId, now);
        const result = await tryReasoning(data, input.purpose);
        logger.info('api', 'model_reasoning_try', { modelId: input.modelId, purpose: input.purpose, ok: result.ok, httpStatus: result.httpStatus,
          firstTextMs: result.firstTextMs, totalMs: result.totalMs, reasoningTokens: result.reasoningTokens, costUsd: result.costUsd,
          finishReason: result.finishReason, error: result.error });
        return result;
      } catch (cause) {
        if (cause instanceof TryRefused) { lastTry.delete(input.modelId); throw new TRPCError({ code: 'BAD_REQUEST', message: cause.message }); }
        throw createSafeInternalError(cause, '试用失败，请稍后重试');
      }
    }),

  get: adminProcedure.input(modelInput).query(async ({ ctx, input }) => view(await readModel(ctx.supabase, input.modelId))),

  /** Reads the public catalog for this model and stores the catalog and price
   * snapshots; route, purposes and every other key are kept. */
  refreshCatalog: adminProcedure.input(modelInput).mutation(async ({ ctx, input }) => {
    const row = await readModel(ctx.supabase, input.modelId);
    let read;
    try {
      read = await readOpenRouterCatalog(row.model_id);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      logger.warn('api', 'model_catalog_read_failed', { modelId: row.id, code: catalogMessages[code] ? code : 'MODEL_CATALOG_UNAVAILABLE' });
      throw new TRPCError({ code: 'BAD_REQUEST', message: catalogMessages[code] ?? '暂时无法读取 OpenRouter 目录，请稍后重试' });
    }
    const saved = await writeReasoning(ctx.supabase, row.id, (current, latest) => {
      // The model ID changed during the read: the snapshot belongs to the old model, so store nothing.
      if (latest.model_id !== read.catalog.model) throw new TRPCError({ code: 'CONFLICT', message: '模型 ID 刚被修改，请重新读取' });
      return { ...current, catalog: read.catalog };
    }, read.pricing);
    const previous = readPricingSnapshot(saved.row.config);
    const priceChanges = diffPricing(previous, read.pricing);
    logger.info('api', 'model_price_snapshot_changed', {
      trigger: 'admin', profileId: ctx.profileId, modelId: row.id, model: row.model_id, outcome: 'written',
      previousHash: previous?.pricingHash ?? null, pricingHash: read.pricing.pricingHash, changes: priceChanges.slice(0, 50),
      catalogChanged: JSON.stringify(readReasoningConfig(saved.row.config).catalog?.endpoints ?? null) !== JSON.stringify(read.catalog.endpoints),
    });
    return { ...saved.view, priceChanges, previousCapacity: modelCapacityView({ ...saved.row, config: { reasoning: saved.view.config } }) };
  }),

  /** Saves the route and purpose settings after checking them against the stored catalog. */
  save: adminProcedure
    .input(z.object({ modelId: z.string().uuid(), route: z.string().min(1).max(128).nullable(), purposes: purposeSettings }).strict())
    .mutation(async ({ ctx, input }) => (await writeReasoning(ctx.supabase, input.modelId, (current, row) => {
      const next: ReasoningConfig = { catalog: current.catalog, route: input.route, purposes: input.purposes };
      const issues = checkReasoningConfig(next, { maxTokens: Number(row.max_tokens) || 0, modelId: row.model_id });
      if (issues.length) throw new TRPCError({ code: 'BAD_REQUEST', message: issues.map(issue => issue.message).join('；') });
      return next;
    })).view),
});
