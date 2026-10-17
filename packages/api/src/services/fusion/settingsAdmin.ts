/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isPlainOpenRouterModel } from '../openRouterSearch';
import { admissionDeadline } from '../runtime/admissionLimits';
import { stagingRuntimeWindow } from '../runtime/stagingEnvironment';
import { realRuntimeEnvironment } from '../runtime/productionEnvironment';
import { loadProductionPolicy } from '../runtime/productionPolicy';
import { parseStagingPolicy, type StagingPolicy } from '../runtime/stagingPolicy';
import { admitFusionModel, FUSION_MODEL_COLUMNS, type FusionModelRow, type FusionPhase } from './models';
import { readOpenRouterKey } from '../models/openRouterKey';
import { readReviewSkill, resolveReviewSkill } from './reviewPrompts';
import { fusionSettings, readFusionSettings, writeFusionSettings, type FusionSettings } from './settings';

/** Administrator save. Every listed model must be a plain model (no built-in search); turning the
 * review mode on also requires each model to pass the same billing admission as a real review. */
export async function saveFusionSettings(db: SupabaseClient, actorId: string, value: unknown,
  env: Record<string, string | undefined> = process.env): Promise<{ settings: FusionSettings; warnings: string[] }> {
  const parsed = fusionSettings.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues.find(issue => issue.message.startsWith('FUSION_'))?.message
    ?? 'FUSION_SETTINGS_INVALID');
  const settings = parsed.data;
  const warnings: string[] = [];
  const ids = [...settings.review.reviewerModelIds, ...(settings.review.summaryModelId ? [settings.review.summaryModelId] : [])];
  if (ids.length) {
    const rows = await db.from('ai_models').select(FUSION_MODEL_COLUMNS).in('id', [...new Set(ids)]);
    if (rows.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
    const models = rows.data as FusionModelRow[];
    if (ids.some(id => !models.some(row => row.id === id))) throw new Error('FUSION_MODEL_UNAVAILABLE');
    if (models.some(row => !isPlainOpenRouterModel(row.model_id))) throw new Error('FUSION_MODEL_SEARCH_DENIED');
    // A hint, never a refusal (总控 2026-10-14): all three reviewers from one company.
    const vendors = new Set(settings.review.reviewerModelIds.map(id => models.find(row => row.id === id)?.model_id.split('/')[0]));
    if (settings.review.reviewerModelIds.length > 1 && vendors.size === 1) warnings.push('FUSION_REVIEWERS_SAME_PROVIDER');
    if (settings.review.enabled) {
      // The selected Skill must be published with a readable package, or every start would fail (#962 review).
      if (settings.review.skillId) await readReviewSkill(db, await resolveReviewSkill(db, settings.review.skillId));
      const window = await adminWindow(db, actorId, env);
      const deadline = admissionDeadline(window.expiresAt);
      const key = await readOpenRouterKey(db, { fresh: true }).catch(() => null); // one fresh read for all checks
      for (const row of models) {
        if (settings.review.reviewerModelIds.includes(row.id)) {
          await admitFusionModel(db, window, row, 'fusion_review', settings.review.opinionOutputTokens, deadline, env, key ?? null);
        }
        if (settings.review.summaryModelId === row.id) {
          await admitFusionModel(db, window, row, 'fusion_summary', settings.review.summaryOutputTokens, deadline, env, key ?? null);
        }
      }
    }
  }
  return { settings: await writeFusionSettings(db, settings), warnings };
}

export const fusionSettingsView = (db: SupabaseClient) => readFusionSettings(db);

/** The staging window as an administrator reads it; administrators need not be test-call actors and nothing is admitted. */
async function adminWindow(db: SupabaseClient, actorId: string, env: Record<string, string | undefined>) {
  // RUNTIME-PROD: production has no window; the admin route already requires an administrator.
  if (realRuntimeEnvironment(env) === 'production')
    // Offline: settings reads never renew a price snapshot over the network.
    return loadProductionPolicy(db, actorId, env, {}, { offline: true }).catch(() => { throw new Error('FUSION_SETTINGS_UNAVAILABLE'); });
  const windowId = stagingRuntimeWindow(env);
  const result = await db.rpc('report_model_window', { p_actor_id: actorId, p_window_id: windowId });
  if (result.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
  return parseStagingPolicy(result.data, windowId);
}

/** Refusals that mean "this model may not do this", as opposed to an outage. */
const NOT_ELIGIBLE = new Set(['FUSION_MODEL_UNAVAILABLE', 'FUSION_MODEL_SEARCH_DENIED', 'FUSION_MODEL_ADMISSION_REQUIRED', 'FUSION_PAYG_REQUIRED',
  'RUNTIME_REASONING_CONFIG_INVALID', 'RUNTIME_REASONING_NOT_CONFIGURED', 'RUNTIME_REASONING_ROUTE_MISMATCH',
  // No per-call billing profile entry for this purpose and output size: an ordinary-only model, not an outage.
  'RUNTIME_PAYG_PROFILE_REQUIRED']);

/** The models an administrator can pick for the panel (FUSION-REVIEW PR-5): the window's models, each checked by the
 * same admission a save of an enabled panel uses, for the reviewer and the summary purpose separately. Read-only. */
export async function fusionModelOptions(db: SupabaseClient, actorId: string, env: Record<string, string | undefined> = process.env,
  given?: StagingPolicy): Promise<{ models: Array<{ id: string; name: string; review: boolean; summary: boolean }> }> {
  const settings = await readFusionSettings(db);
  const window = given ?? await adminWindow(db, actorId, env);
  const rows = await db.from('ai_models').select(FUSION_MODEL_COLUMNS).in('id', window.callPolicies.map(policy => policy.modelId));
  if (rows.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
  const deadline = admissionDeadline(window.expiresAt);
  // Read-only listing: one read (the 60 s cache is fine for a display) shared by every per-model check.
  const key = await readOpenRouterKey(db).catch(() => null);
  const admits = async (row: FusionModelRow, phase: FusionPhase, tokens: number) => {
    try { await admitFusionModel(db, window, row, phase, tokens, deadline, env, key ?? null); return true; }
    catch (error) {
      if (NOT_ELIGIBLE.has(error instanceof Error ? error.message : '')) return false;
      throw new Error('FUSION_SETTINGS_UNAVAILABLE');
    }
  };
  const models = [];
  for (const row of (rows.data ?? []) as Array<FusionModelRow & { name?: string }>) {
    const review = await admits(row, 'fusion_review', settings.review.opinionOutputTokens);
    const summary = await admits(row, 'fusion_summary', settings.review.summaryOutputTokens);
    if (review || summary) models.push({ id: row.id, name: row.name ?? row.model_id, review, summary });
  }
  return { models };
}
