/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { router, adminProcedure } from '../trpc';
import { logger } from '../lib/logger';
import { readOpenRouterCatalog } from '../services/models/openRouterCatalog';
import { checkReasoningConfig, purposeSettings, readReasoningConfig, type ReasoningConfig } from '../shared/modelReasoning';

/** Administrator reasoning settings (MODEL-REASONING). Only these procedures
 * write `ai_models.config.reasoning`; the Runtime does not read it yet. */
const modelInput = z.object({ modelId: z.string().uuid() }).strict();
const catalogMessages: Record<string, string> = {
  MODEL_CATALOG_ID_INVALID: '模型 ID 格式不受支持，无法读取目录',
  MODEL_CATALOG_NOT_FOUND: 'OpenRouter 目录里没有这个模型，请核对模型 ID',
  MODEL_CATALOG_TOO_LARGE: 'OpenRouter 目录返回的数据过大，请稍后重试',
  MODEL_CATALOG_INVALID: 'OpenRouter 目录返回的格式无法识别，没有保存；原有快照保持不变',
};

async function readModel(db: SupabaseClient, modelId: string) {
  const { data, error } = await db.from('ai_models').select('id,model_id,max_tokens,config').eq('id', modelId).maybeSingle();
  if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '无法读取模型配置，请稍后重试' });
  if (!data) throw new TRPCError({ code: 'NOT_FOUND', message: '模型不存在，请刷新列表' });
  return data as { id: string; model_id: string; max_tokens: number | null; config: unknown };
}
function view(row: { model_id: string; max_tokens: number | null; config: unknown }) {
  const config = readReasoningConfig(row.config);
  const maxTokens = Number(row.max_tokens) || 0;
  return { model: row.model_id, maxTokens, config, issues: checkReasoningConfig(config, { maxTokens, modelId: row.model_id }) };
}
/** Replaces only the `reasoning` key, on the row's current config. */
async function writeReasoning(db: SupabaseClient, modelId: string, reasoning: ReasoningConfig) {
  const current = await readModel(db, modelId);
  const base = current.config && typeof current.config === 'object' && !Array.isArray(current.config) ? current.config as Record<string, unknown> : {};
  const { error } = await db.from('ai_models').update({ config: { ...base, reasoning }, updated_at: new Date().toISOString() }).eq('id', modelId);
  if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '保存思考设置失败，请稍后重试' });
  return view({ ...current, config: { ...base, reasoning } });
}

export const modelReasoningRouter = router({
  get: adminProcedure.input(modelInput).query(async ({ ctx, input }) => view(await readModel(ctx.supabase, input.modelId))),

  /** Reads the public catalog for this model and stores the snapshot; route and purposes are kept. */
  refreshCatalog: adminProcedure.input(modelInput).mutation(async ({ ctx, input }) => {
    const row = await readModel(ctx.supabase, input.modelId);
    let catalog;
    try {
      catalog = await readOpenRouterCatalog(row.model_id);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      logger.warn('api', 'model_catalog_read_failed', { modelId: row.id, code: catalogMessages[code] ? code : 'MODEL_CATALOG_UNAVAILABLE' });
      throw new TRPCError({ code: 'BAD_REQUEST', message: catalogMessages[code] ?? '暂时无法读取 OpenRouter 目录，请稍后重试' });
    }
    return writeReasoning(ctx.supabase, row.id, { ...readReasoningConfig(row.config), catalog });
  }),

  /** Saves the route and purpose settings after checking them against the stored catalog. */
  save: adminProcedure
    .input(z.object({ modelId: z.string().uuid(), route: z.string().min(1).max(128).nullable(), purposes: purposeSettings }).strict())
    .mutation(async ({ ctx, input }) => {
      const row = await readModel(ctx.supabase, input.modelId);
      const next: ReasoningConfig = { catalog: readReasoningConfig(row.config).catalog, route: input.route, purposes: input.purposes };
      const issues = checkReasoningConfig(next, { maxTokens: Number(row.max_tokens) || 0, modelId: row.model_id });
      if (issues.length) throw new TRPCError({ code: 'BAD_REQUEST', message: issues.map(issue => issue.message).join('；') });
      return writeReasoning(ctx.supabase, row.id, next);
    }),
});
