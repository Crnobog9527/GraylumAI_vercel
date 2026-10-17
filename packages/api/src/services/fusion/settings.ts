/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PURPOSE_OUTPUT_CAP } from '../bill2/responseCapacity';

/** Fusion settings (Master Plan §4.5): one existing system_settings row, no new table. The database
 * admission (0235 fusion_group_admit) reads the same row in its transaction. */
export const FUSION_SETTINGS_KEY = 'fusion_settings';
/** BILL2 keeps 32 calls per run; one review uses at most rounds × (reviewers + 1) runs (FUSION-REVIEW §3.2). */
export const FUSION_MAX_REVIEW_CALLS = 32;
/** The system ceiling of D3 (fusion_compare_max_models is 2..8, 0153). */
export const COMPARE_MAX_MODELS = 8;
const usd = z.string().regex(/^(0|[1-9]\d{0,3})(\.\d{1,6})?$/).refine(value => Number(value) > 0);
/** Panel display names (Owner 2026-10-14): shown in the review animation, stored apart from the model choice, so
 * changing a model never changes a name. Trimmed, control characters removed, 1–20 characters. */
export const PANEL_SEATS = ['A', 'B', 'C'] as const;
export const DEFAULT_PANEL_NAMES = { reviewers: ['评审 A', '评审 B', '评审 C'], summary: '汇总' };
const panelName = z.string().transform(value => value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim())
  .refine(value => [...value].length >= 1 && [...value].length <= 20, { message: 'FUSION_PANEL_NAME_INVALID' });
const panelNames = z.object({ reviewers: z.array(panelName).length(PANEL_SEATS.length), summary: panelName }).strict();
const review = z.object({
  enabled: z.boolean(),
  /** Exactly three seats (A, B, C) when enabled (Owner 2026-10-14: "三家最强的模型"). */
  reviewerModelIds: z.array(z.string().uuid()).max(PANEL_SEATS.length),
  summaryModelId: z.string().uuid().nullable(),
  /** The review Skill is chosen here and frozen per run (PR-4). */
  skillId: z.string().uuid().nullable(),
  /** 1 = no debate round; 2 = a debate round when reviewers split over a key decision (Owner 2026-10-14). */
  maxRounds: z.number().int().min(1).max(2),
  /** Per opinion, reasoning tokens included; set explicitly on every review request. */
  opinionOutputTokens: z.number().int().min(512).max(PURPOSE_OUTPUT_CAP),
  summaryOutputTokens: z.number().int().min(1024).max(PURPOSE_OUTPUT_CAP),
  /** Platform cost protection line per review in USD (provider cost bound, not what the user pays); above it the
   * debate round is dropped. No default, so enabling requires an administrator value. */
  maxBudgetUsd: usd.nullable(),
  /** What the user pays per review, in credits (Owner 2026-10-17 "暂定每次 1500 积分"): held at start, charged only
   * for a usable revision, refunded on failure. Administrators may change it; 0294 reads the same value. */
  fixedPriceCredits: z.number().int().min(1).max(999999).default(1500),
  /** A claimed call not dispatched within this time is cancelled by the daily reconciliation. */
  dispatchMinutes: z.number().int().min(1).max(60),
  /** Platform-borne cost breaker per user over 7 days (§3.3); used by review admission (PR-4). */
  breaker: z.object({ platformUsd: usd, noDeliveryCalls: z.number().int().min(1).max(1000) }).strict(),
  displayNames: panelNames.default(DEFAULT_PANEL_NAMES),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (new Set(value.reviewerModelIds).size !== value.reviewerModelIds.length) issue('FUSION_REVIEWERS_DUPLICATE');
  if (value.maxRounds * (value.reviewerModelIds.length + 1) > FUSION_MAX_REVIEW_CALLS) issue('FUSION_REVIEW_CALLS_EXCEEDED');
  if (value.enabled && (value.reviewerModelIds.length !== PANEL_SEATS.length || !value.summaryModelId || !value.maxBudgetUsd
    || !value.skillId)) {
    issue('FUSION_REVIEW_INCOMPLETE');
  }
});
/** Multi-model compare (FUSION-COMPARE §3.3). The database admission (0290) reads the same row. Stored rows from before
 * this task only have `enabled`; every other field then takes its default, which keeps the mode off and unusable. */
const compare = z.object({
  enabled: z.boolean(),
  /** What users may pick (administrator allowlist); every model must pass the compare admission to be saved when enabled. */
  allowedModelIds: z.array(z.string().uuid()).max(16).default([]),
  /** What is ticked each time the picker opens; a subset of the allowlist. */
  defaultModelIds: z.array(z.string().uuid()).max(COMPARE_MAX_MODELS).default([]),
  /** At least this many models per compare (Owner 2026-10-03: 2 <= min <= D3; D3 is checked against the database value on save). */
  minModels: z.number().int().min(2).max(COMPARE_MAX_MODELS).default(2),
  /** Per answer, reasoning tokens included; frozen on every column of a compare. */
  answerOutputTokens: z.number().int().min(512).max(PURPOSE_OUTPUT_CAP).default(8192),
  /** Single-compare budget in USD (the sum of the columns' bounds); no default, so enabling requires an administrator value. */
  maxBudgetUsd: usd.nullable().default(null),
  /** A claimed call not dispatched within this time is cancelled by the daily reconciliation. */
  dispatchMinutes: z.number().int().min(1).max(60).default(10),
  /** Platform-borne cost breaker per user over 7 days; the same statistic as reviews (§3.6). */
  breaker: z.object({ platformUsd: usd, noDeliveryCalls: z.number().int().min(1).max(1000) }).strict()
    .default({ platformUsd: '2', noDeliveryCalls: 10 }),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (new Set(value.allowedModelIds).size !== value.allowedModelIds.length) issue('FUSION_COMPARE_ALLOWED_DUPLICATE');
  if (new Set(value.defaultModelIds).size !== value.defaultModelIds.length
    || value.defaultModelIds.some(id => !value.allowedModelIds.includes(id))) issue('FUSION_COMPARE_DEFAULT_NOT_ALLOWED');
  if (value.enabled && (value.allowedModelIds.length < value.minModels || value.defaultModelIds.length < value.minModels
    || !value.maxBudgetUsd)) {
    issue('FUSION_COMPARE_INCOMPLETE');
  }
});
export const fusionSettings = z.object({ version: z.literal(1), review, compare }).strict();
export type FusionSettings = z.infer<typeof fusionSettings>;

/** Both modes off by default (Master Plan §4.2). 3 reviewers + 1 summary, at most 2 rounds (Owner 2026-10-13). */
export const DEFAULT_FUSION_SETTINGS: FusionSettings = {
  version: 1,
  review: { enabled: false, reviewerModelIds: [], summaryModelId: null, skillId: null, maxRounds: 2,
    opinionOutputTokens: 4096,
    // The summary writes the whole report plus a ruling per issue: 16384 was cut off in a staging run (#962).
    summaryOutputTokens: PURPOSE_OUTPUT_CAP, maxBudgetUsd: null, fixedPriceCredits: 1500,
    dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 }, displayNames: DEFAULT_PANEL_NAMES },
  compare: { enabled: false, allowedModelIds: [], defaultModelIds: [], minModels: 2, answerOutputTokens: 8192, maxBudgetUsd: null,
    dispatchMinutes: 10, breaker: { platformUsd: '2', noDeliveryCalls: 10 } },
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

/** Only what the D3 floor needs: the compare minimum and the default tick count, read leniently. D3 must stay changeable
 * when the rest of the row is invalid (it would otherwise be impossible to repair), so nothing here is strict-parsed. */
export async function readCompareFloor(db: SupabaseClient): Promise<{ minModels: number; defaultCount: number }> {
  const result = await db.from('system_settings').select('value').eq('key', FUSION_SETTINGS_KEY).maybeSingle();
  if (result.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
  let value: unknown = result.data?.value;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  const compare = (value && typeof value === 'object' ? (value as { compare?: unknown }).compare : null) as
    { minModels?: unknown; defaultModelIds?: unknown } | null;
  const min = typeof compare?.minModels === 'number' && Number.isInteger(compare.minModels) ? compare.minModels : 2;
  return { minModels: min, defaultCount: Array.isArray(compare?.defaultModelIds) ? compare.defaultModelIds.length : 0 };
}

/** Writes an already validated value (model eligibility is checked by the caller). */
export async function writeFusionSettings(db: SupabaseClient, value: FusionSettings): Promise<FusionSettings> {
  const parsed = fusionSettings.parse(value);
  const result = await db.from('system_settings').upsert({ key: FUSION_SETTINGS_KEY, value: parsed }, { onConflict: 'key' });
  if (result.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
  return parsed;
}
