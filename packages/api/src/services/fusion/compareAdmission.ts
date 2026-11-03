/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { decimal } from '../turn/provider/decimal';
import { assertFusionEntitlement, readMembershipEntitlements } from '../membershipEntitlements';
import { readFusionSettings, type FusionSettings } from './settings';

/** Exact SQL refusals only; anything else is reported as unavailable, never with database detail. */
const refusals = new Set(['OPC_BUSINESS_ARCHIVED', 'FUSION_COMPARE_DISABLED', 'FUSION_COMPARE_FORBIDDEN', 'FUSION_COMPARE_TOO_FEW', 'FUSION_COMPARE_TOO_MANY',
  'FUSION_COMPARE_MODEL_NOT_ALLOWED', 'FUSION_COMPARE_DENIED', 'FUSION_COMPARE_ENDED', 'FUSION_COMPARE_GATE_REQUIRED',
  'RUNTIME_MATERIAL_UNAVAILABLE', 'FUSION_COMPARE_ACTIVE', 'FUSION_COMPARE_BREAKER', 'FUSION_COMPARE_STALE', 'FUSION_COMPARE_SESSION_GONE',
  'FUSION_COMPARE_REQUEST_CONFLICT', 'FUSION_COMPARE_INVALID', 'FUSION_COMPARE_SOURCE_REVOKED', 'FUSION_COMPARE_SETTINGS_INVALID',
  'FUSION_COMPARE_CLAIM_INCOMPLETE', 'FUSION_COMPARE_NOT_CLAIMED', 'FUSION_COMPARE_ADOPTED', 'FUSION_COMPARE_NOT_ADOPTABLE',
  'FUSION_MEMBERSHIP_REQUIRED', 'REPORT_MEMBERSHIP_REQUIRED', 'REPORT_ENTITLEMENTS_UNAVAILABLE', 'FUSION_BUDGET_EXCEEDED',
  'FUSION_GROUP_INVALID', 'FUSION_GROUP_CONFLICT', 'FUSION_GROUP_DENIED', 'BILL2_REQUEST_CONFLICT', 'RUNTIME_TEST_WINDOW_DENIED',
  'RUNTIME_TEST_MODEL_DENIED']);
export async function compareRpc<T>(admin: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await admin.rpc(name, args);
  if (result.error) {
    const message = typeof result.error.message === 'string' ? result.error.message : '';
    throw new Error(refusals.has(message) ? message : 'FUSION_ADMISSION_UNAVAILABLE');
  }
  return result.data as T;
}

/** The live rules every compare start checks before anything is priced (also for a replay: a request admitted while
 * the user waited may meet a switch, allowlist or membership that changed since). Reads the stored settings and the
 * membership facts of this moment; the database repeats them in its own transaction. */
export async function assertCompareAllowed(admin: SupabaseClient, actorId: string, modelIds: string[]): Promise<FusionSettings['compare']> {
  const settings = (await readFusionSettings(admin)).compare;
  if (!settings.enabled) throw new Error('FUSION_COMPARE_DISABLED');
  const entitlements = await readMembershipEntitlements(admin, actorId);
  if (!entitlements.allowFusionCompare) throw new Error('FUSION_COMPARE_FORBIDDEN');
  if (modelIds.length < settings.minModels) throw new Error('FUSION_COMPARE_TOO_FEW');
  if (modelIds.length > Math.min(entitlements.fusionCompareMaxModels, 8)) throw new Error('FUSION_COMPARE_TOO_MANY');
  if (new Set(modelIds).size !== modelIds.length || modelIds.some(id => !settings.allowedModelIds.includes(id))) {
    throw new Error('FUSION_COMPARE_MODEL_NOT_ALLOWED');
  }
  assertFusionEntitlement(entitlements, 'compare', modelIds.length);
  return settings;
}

/** What the user agreed to, per column in the chosen order. The group may not hold more than this, in credits or provider
 * cost, in total or in any column, and must have exactly these columns. Checked before anything is recorded and again at
 * admission, so a forged or stale quote never reaches the paid positioning judgement. */
export type ShownQuote = { credits: number; columns: Array<{ modelId?: string; credits: number; usd: string }> };
export function assertQuoteCovers(columns: ReadonlyArray<{ index: number; modelId: string; upperCredits: number; upperUsd: string }>,
  shown: ShownQuote) {
  const shownUsd = shown.columns.reduce((sum, column) => sum + decimal(column.usd), 0n);
  const credits = columns.reduce((sum, column) => sum + column.upperCredits, 0);
  const usd = columns.reduce((sum, column) => sum + decimal(column.upperUsd), 0n);
  if (shown.columns.length !== columns.length || credits > shown.credits || usd > shownUsd
    || columns.some(column => { const cap = shown.columns[column.index];
      return !cap || (cap.modelId !== undefined && cap.modelId !== column.modelId)
        || column.upperCredits > cap.credits || decimal(column.upperUsd) > decimal(cap.usd); })) {
    throw new Error('FUSION_COMPARE_PRICE_CHANGED');
  }
}
