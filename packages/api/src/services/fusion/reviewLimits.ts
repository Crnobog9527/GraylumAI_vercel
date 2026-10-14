/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { FusionMember } from './admission';

/** R14 refusals of an adoption that retrying cannot fix (finished as refused); transient ones (REPORT_UNAVAILABLE, auth)
 * are retried by the client. */
export const PERMANENT_REFUSALS = new Set(['REPORT_REVISION_STALE', 'REPORT_SOURCE_CONFLICT', 'CONTENT_ERASED',
  'REPORT_NOT_COMPLETE', 'REPORT_REVISION_UNSUPPORTED',
  // R14 replays an identical decision first (0223), so this means the proposal was decided elsewhere (#962 review).
  'REPORT_REVISION_DECIDED']);
/** Refusals that will not clear by retrying the same claim (a size or price bound, a setting changed by an
 * administrator, a lapsed entitlement or test window). Every claim goes through one place, so each of them ends the
 * step instead of leaving a review that can never move (#962 review); transient failures are thrown and retried. */
export const CLAIM_REFUSALS: Record<string, string> = { FUSION_INPUT_TOO_LARGE: 'input_too_large', FUSION_ESTIMATE_EXCEEDED: 'price_changed',
  FUSION_BUDGET_EXCEEDED: 'price_changed', FUSION_REVIEW_DISABLED: 'claim_refused', FUSION_MODEL_DENIED: 'claim_refused',
  FUSION_MODEL_UNAVAILABLE: 'claim_refused', FUSION_MODEL_ADMISSION_REQUIRED: 'claim_refused', FUSION_MODEL_SEARCH_DENIED: 'claim_refused',
  FUSION_PAYG_REQUIRED: 'claim_refused', FUSION_MEMBERSHIP_REQUIRED: 'claim_refused', ENTITLEMENTS_FUSION_FORBIDDEN: 'claim_refused',
  FUSION_GROUP_DENIED: 'claim_refused', BILL2_PAYG_QUOTE_INVALID: 'claim_refused', BILL2_UNIT_MULTIPLIER_INVALID: 'claim_refused',
  BILL2_INPUT_BOUND_CONFLICT: 'claim_refused', RUNTIME_STAGING_MODEL_DENIED: 'claim_refused', RUNTIME_STAGING_WINDOW_EXPIRED: 'claim_refused',
  RUNTIME_STAGING_POLICY_INVALID: 'claim_refused', RUNTIME_STAGING_QUOTE_CONFLICT: 'claim_refused',
  RUNTIME_BILLING_UNIT_MISMATCH: 'claim_refused', RUNTIME_BILLING_UNIT_WINDOW_OUTDATED: 'claim_refused' };
/** The bounds of exactly the members claimed now: a retry of some seats gets only theirs (#962 review). A member
 * without a frozen bound (a phase the estimate did not allow) gets zero, so it can never be claimed. */
export const memberCaps = (caps: Record<string, { credits: number; usd: string }> | undefined, members: FusionMember[]) => {
  if (!caps) return {};
  const own = members.map(member => caps[member.modelId] ?? { credits: 0, usd: '0' });
  const micros = own.reduce((sum, cap) => sum + Math.round(Number(cap.usd) * 1e6), 0);
  return { maxCredits: own.reduce((sum, cap) => sum + cap.credits, 0), maxUsd: (micros / 1e6).toFixed(6) };
};
