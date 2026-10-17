/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isPlainOpenRouterModel } from '../openRouterSearch';
import { admissionDeadline } from '../runtime/admissionLimits';
import { stagingRuntimeWindow } from '../runtime/stagingEnvironment';
import { parseStagingPolicy, type StagingPolicy } from '../runtime/stagingPolicy';
import { admitFusionModel, FUSION_MODEL_COLUMNS, type FusionModelRow, type FusionPhase } from './models';
import { readOpenRouterKey } from '../models/openRouterKey';
import { readReviewSkill, resolveReviewSkill } from './reviewPrompts';
import { fusionSettings, readFusionSettings, writeFusionSettings, type FusionSettings } from './settings';
import { FUSION_COMPARE_SETTING, fusionCompareLimitSchema } from '../membershipEntitlementConfig';

/** Administrator save. Every listed model must be a plain model (no built-in search); turning a mode on also
 * requires each of its models to pass the same billing admission as a real run (review: its seats; compare: every
 * allowed model). Compare limits are checked against the stored D3 (fusion_compare_max_models). */
export async function saveFusionSettings(db: SupabaseClient, actorId: string, value: unknown,
  env: Record<string, string | undefined> = process.env): Promise<{ settings: FusionSettings; warnings: string[] }> {
  const parsed = fusionSettings.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues.find(issue => issue.message.startsWith('FUSION_'))?.message
    ?? 'FUSION_SETTINGS_INVALID');
  const settings = parsed.data;
  const warnings: string[] = [];
  // Owner 2026-10-03: 2 <= minModels <= D3. The default tick count is held to the same ceiling.
  const compareMax = await readCompareMaxModels(db);
  if (settings.compare.minModels > compareMax || settings.compare.defaultModelIds.length > compareMax) {
    throw new Error('FUSION_COMPARE_LIMIT_EXCEEDED');
  }
  const ids = [...settings.review.reviewerModelIds, ...(settings.review.summaryModelId ? [settings.review.summaryModelId] : []),
    ...settings.compare.allowedModelIds];
  if (ids.length) {
    const rows = await db.from('ai_models').select(FUSION_MODEL_COLUMNS).in('id', [...new Set(ids)]);
    if (rows.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
    const models = rows.data as FusionModelRow[];
    if (ids.some(id => !models.some(row => row.id === id))) throw new Error('FUSION_MODEL_UNAVAILABLE');
    if (models.some(row => !isPlainOpenRouterModel(row.model_id))) throw new Error('FUSION_MODEL_SEARCH_DENIED');
    // A hint, never a refusal (总控 2026-10-14): all three reviewers from one company.
    const vendors = new Set(settings.review.reviewerModelIds.map(id => models.find(row => row.id === id)?.model_id.split('/')[0]));
    if (settings.review.reviewerModelIds.length > 1 && vendors.size === 1) warnings.push('FUSION_REVIEWERS_SAME_PROVIDER');
    if (settings.review.enabled || settings.compare.enabled) {
      // The selected Skill must be published with a readable package, or every start would fail (#962 review).
      if (settings.review.enabled && settings.review.skillId) {
        await readReviewSkill(db, await resolveReviewSkill(db, settings.review.skillId));
      }
      const window = await adminWindow(db, actorId, env);
      const deadline = admissionDeadline(window.expiresAt);
      const key = await readOpenRouterKey(db, { fresh: true }).catch(() => null); // one fresh read for all checks
      for (const row of models) {
        if (settings.review.enabled && settings.review.reviewerModelIds.includes(row.id)) {
          await admitFusionModel(db, window, row, 'fusion_review', settings.review.opinionOutputTokens, deadline, env, key ?? null);
        }
        if (settings.review.enabled && settings.review.summaryModelId === row.id) {
          await admitFusionModel(db, window, row, 'fusion_summary', settings.review.summaryOutputTokens, deadline, env, key ?? null);
        }
        // Compare: every allowed model must pass, or users would be offered a choice that can never run.
        if (settings.compare.enabled && settings.compare.allowedModelIds.includes(row.id)) {
          await admitFusionModel(db, window, row, 'fusion_compare', settings.compare.answerOutputTokens, deadline, env, key ?? null);
        }
      }
    }
  }
  return { settings: await writeFusionSettings(db, settings), warnings };
}

/** D3 as stored (system_settings.fusion_compare_max_models, 2..8 by a database check); the entitlement default is 4. */
export async function readCompareMaxModels(db: SupabaseClient): Promise<number> {
  const result = await db.from('system_settings').select('value').eq('key', FUSION_COMPARE_SETTING).maybeSingle();
  if (result.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
  if (!result.data) return 4;
  const parsed = fusionCompareLimitSchema.safeParse(typeof result.data.value === 'string' ? Number(result.data.value) : result.data.value);
  if (!parsed.success) throw new Error('FUSION_SETTINGS_INVALID');
  return parsed.data;
}

export const fusionSettingsView = (db: SupabaseClient) => readFusionSettings(db);

/** The staging window as an administrator reads it; administrators need not be test-call actors and nothing is admitted. */
async function adminWindow(db: SupabaseClient, actorId: string, env: Record<string, string | undefined>) {
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
  given?: StagingPolicy): Promise<{ models: Array<{ id: string; name: string; review: boolean; summary: boolean; compare: boolean }> }> {
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
    const compare = await admits(row, 'fusion_compare', settings.compare.answerOutputTokens);
    if (review || summary || compare) models.push({ id: row.id, name: row.name ?? row.model_id, review, summary, compare });
  }
  return { models };
}
