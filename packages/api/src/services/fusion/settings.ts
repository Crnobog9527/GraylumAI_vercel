/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PURPOSE_OUTPUT_CAP } from '../bill2/responseCapacity';

/** Fusion settings (Master Plan §4.5): one existing system_settings row, no new table. The database
 * admission (0235 fusion_group_admit) reads the same row in its transaction. */
export const FUSION_SETTINGS_KEY = 'fusion_settings';
/** BILL2 keeps 32 calls per run; one review uses at most rounds × (reviewers + 1) runs (FUSION-REVIEW §3.2). */
export const FUSION_MAX_REVIEW_CALLS = 32;
const usd = z.string().regex(/^(0|[1-9]\d{0,3})(\.\d{1,6})?$/).refine(value => Number(value) > 0);
const review = z.object({
  enabled: z.boolean(),
  reviewerModelIds: z.array(z.string().uuid()).max(8),
  summaryModelId: z.string().uuid().nullable(),
  /** The review Skill is chosen here and frozen per run (PR-4). */
  skillId: z.string().uuid().nullable(),
  maxRounds: z.number().int().min(1).max(8),
  /** Per opinion, reasoning tokens included; set explicitly on every review request. */
  opinionOutputTokens: z.number().int().min(512).max(PURPOSE_OUTPUT_CAP),
  summaryOutputTokens: z.number().int().min(1024).max(PURPOSE_OUTPUT_CAP),
  /** Single-review budget in USD; no default, so enabling requires an administrator value. */
  maxBudgetUsd: usd.nullable(),
  /** A claimed call not dispatched within this time is cancelled by the daily reconciliation. */
  dispatchMinutes: z.number().int().min(1).max(60),
  /** Platform-borne cost breaker per user over 7 days (§3.3); used by review admission (PR-4). */
  breaker: z.object({ platformUsd: usd, noDeliveryCalls: z.number().int().min(1).max(1000) }).strict(),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (new Set(value.reviewerModelIds).size !== value.reviewerModelIds.length) issue('FUSION_REVIEWERS_DUPLICATE');
  if (value.maxRounds * (value.reviewerModelIds.length + 1) > FUSION_MAX_REVIEW_CALLS) issue('FUSION_REVIEW_CALLS_EXCEEDED');
  if (value.enabled && (value.reviewerModelIds.length < 3 || !value.summaryModelId || !value.maxBudgetUsd)) {
    issue('FUSION_REVIEW_INCOMPLETE');
  }
});
export const fusionSettings = z.object({
  version: z.literal(1), review,
  /** Compare mode switch; its model list and limits arrive with FUSION-COMPARE. */
  compare: z.object({ enabled: z.boolean() }).strict(),
}).strict();
export type FusionSettings = z.infer<typeof fusionSettings>;

/** Both modes off by default (Master Plan §4.2). 3 reviewers + 1 summary, at most 2 rounds (Owner 2026-10-13). */
export const DEFAULT_FUSION_SETTINGS: FusionSettings = {
  version: 1,
  review: { enabled: false, reviewerModelIds: [], summaryModelId: null, skillId: null, maxRounds: 2,
    opinionOutputTokens: 4096, summaryOutputTokens: Math.min(16384, PURPOSE_OUTPUT_CAP), maxBudgetUsd: null,
    dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 } },
  compare: { enabled: false },
};

/** Missing row: defaults (both off). Unreadable or invalid: refuse, never guess a configuration. */
export async function readFusionSettings(db: SupabaseClient): Promise<FusionSettings> {
  const result = await db.from('system_settings').select('value').eq('key', FUSION_SETTINGS_KEY).maybeSingle();
  if (result.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
  if (!result.data) return DEFAULT_FUSION_SETTINGS;
  let value: unknown = result.data.value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error('FUSION_SETTINGS_INVALID'); }
  }
  const parsed = fusionSettings.safeParse(value);
  if (!parsed.success) throw new Error('FUSION_SETTINGS_INVALID');
  return parsed.data;
}

/** Writes an already validated value (model eligibility is checked by the caller). */
export async function writeFusionSettings(db: SupabaseClient, value: FusionSettings): Promise<FusionSettings> {
  const parsed = fusionSettings.parse(value);
  const result = await db.from('system_settings').upsert({ key: FUSION_SETTINGS_KEY, value: parsed }, { onConflict: 'key' });
  if (result.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
  return parsed;
}
