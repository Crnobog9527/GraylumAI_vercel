/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isPlainOpenRouterModel } from '../openRouterSearch';
import { admissionDeadline } from '../runtime/admissionLimits';
import { stagingRuntimeWindow } from '../runtime/stagingEnvironment';
import { parseStagingPolicy } from '../runtime/stagingPolicy';
import { admitFusionModel, FUSION_MODEL_COLUMNS, type FusionModelRow } from './models';
import { fusionSettings, readFusionSettings, writeFusionSettings, type FusionSettings } from './settings';

/** Administrator save. Every listed model must be a plain model (no built-in search); turning the
 * review mode on also requires each model to pass the same billing admission as a real review. */
export async function saveFusionSettings(db: SupabaseClient, actorId: string, value: unknown,
  env: Record<string, string | undefined> = process.env): Promise<FusionSettings> {
  const parsed = fusionSettings.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues.find(issue => issue.message.startsWith('FUSION_'))?.message
    ?? 'FUSION_SETTINGS_INVALID');
  const settings = parsed.data;
  const ids = [...settings.review.reviewerModelIds, ...(settings.review.summaryModelId ? [settings.review.summaryModelId] : [])];
  if (ids.length) {
    const rows = await db.from('ai_models').select(FUSION_MODEL_COLUMNS).in('id', [...new Set(ids)]);
    if (rows.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
    const models = rows.data as FusionModelRow[];
    if (ids.some(id => !models.some(row => row.id === id))) throw new Error('FUSION_MODEL_UNAVAILABLE');
    if (models.some(row => !isPlainOpenRouterModel(row.model_id))) throw new Error('FUSION_MODEL_SEARCH_DENIED');
    if (settings.review.enabled) {
      const windowId = stagingRuntimeWindow(env);
      // Administrators need not be test-call actors; this admin-only read admits no call.
      const result = await db.rpc('report_model_window', { p_actor_id: actorId, p_window_id: windowId });
      if (result.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
      const window = parseStagingPolicy(result.data, windowId);
      const deadline = admissionDeadline(window.expiresAt);
      for (const row of models) {
        if (settings.review.reviewerModelIds.includes(row.id)) {
          await admitFusionModel(db, window, row, 'fusion_review', settings.review.opinionOutputTokens, deadline, env);
        }
        if (settings.review.summaryModelId === row.id) {
          await admitFusionModel(db, window, row, 'fusion_summary', settings.review.summaryOutputTokens, deadline, env);
        }
      }
    }
  }
  return writeFusionSettings(db, settings);
}

export const fusionSettingsView = (db: SupabaseClient) => readFusionSettings(db);
