/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decimal } from '../bill2/decimal';
import {
  BillingUnitConfigError, MULTIPLIER_PATTERN, readMultiplierSnapshot, type MultiplierSnapshot,
} from '../billingUnit';
import { StagingAccessError } from './stagingErrors';

/**
 * BILL-UNIT (0157) for real (staging window) admissions: the window is the approved snapshot of q and
 * each model's m_i, and must equal the current configuration; it is never an independent rate source.
 * Local fixture admissions keep their explicit single-multiplier rates and carry no billingUnit.
 */
const multiplierText = z.string().regex(MULTIPLIER_PATTERN);
const resolved = z.object({ multiplier: multiplierText, source: z.enum(['model', 'provider', 'global']) }).strict();
export const frozenBillingUnit = z.object({
  version: z.literal('bill-unit-v2'),
  creditsPerUsd: z.string(),
  defaultMultiplier: multiplierText,
  models: z.record(z.string().uuid(), resolved),
  providers: z.record(z.string(), resolved),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type FrozenBillingUnit = z.infer<typeof frozenBillingUnit>;

type WindowPolicy = { creditsPerUsd: string; multiplier: string; callPolicies: ReadonlyArray<{ modelId: string; multiplier?: string }> };
type CallPolicy = { modelId: string; multiplier?: string };

/** Window shape check, also for recovery: either no entry has a multiplier (old window) or all do,
 * and none exceeds the window's multiplier, which reserves for the most expensive approved model. */
export function assertWindowMultipliers(window: WindowPolicy) {
  const withM = window.callPolicies.filter((policy) => policy.multiplier !== undefined);
  if (withM.length === 0) return;
  if (withM.length !== window.callPolicies.length) throw new StagingAccessError('RUNTIME_STAGING_POLICY_INVALID');
  for (const policy of withM) {
    if (!multiplierText.safeParse(policy.multiplier).success || decimal(policy.multiplier) > decimal(window.multiplier)) {
      throw new StagingAccessError('RUNTIME_STAGING_POLICY_INVALID');
    }
  }
}

/** Freezes the configuration snapshot for the selected window entries, or refuses the admission. */
export async function freezeWindowBillingUnit(
  admin: SupabaseClient,
  window: WindowPolicy,
  selected: readonly CallPolicy[],
): Promise<MultiplierSnapshot> {
  if (selected.some((policy) => policy.multiplier === undefined)) throw new StagingAccessError('RUNTIME_BILLING_UNIT_WINDOW_OUTDATED');
  let snapshot: MultiplierSnapshot;
  try {
    snapshot = await readMultiplierSnapshot(admin, selected.map((policy) => policy.modelId));
  } catch (cause) {
    if (cause instanceof BillingUnitConfigError) throw new StagingAccessError('RUNTIME_BILLING_UNIT_UNAVAILABLE');
    throw cause;
  }
  if (decimal(snapshot.creditsPerUsd) !== decimal(window.creditsPerUsd)) throw new StagingAccessError('RUNTIME_BILLING_UNIT_MISMATCH');
  for (const policy of selected) {
    const current = snapshot.models[policy.modelId];
    if (!current || decimal(current.multiplier) !== decimal(policy.multiplier!)) {
      throw new StagingAccessError('RUNTIME_BILLING_UNIT_MISMATCH');
    }
  }
  return snapshot;
}

/** The per-call copy of the frozen multiplier (bill2_claim checks it against the call policy). */
export function callBillingUnit(rules: { billingUnit?: FrozenBillingUnit }, policy: CallPolicy) {
  if (!rules.billingUnit || policy.multiplier === undefined) return {};
  const source = rules.billingUnit.models[policy.modelId]?.source;
  if (!source) throw new Error('BILL2_UNIT_MULTIPLIER_INVALID');
  return { billingUnit: { modelId: policy.modelId, multiplier: policy.multiplier, source } };
}
