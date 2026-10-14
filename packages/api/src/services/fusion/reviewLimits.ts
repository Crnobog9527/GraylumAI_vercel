/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { FusionMember } from './admission';

/** R14 refusals of an adoption that retrying cannot fix (finished as refused); transient ones (REPORT_UNAVAILABLE, auth)
 * are retried by the client. */
export const PERMANENT_REFUSALS = new Set(['REPORT_REVISION_STALE', 'REPORT_SOURCE_CONFLICT', 'CONTENT_ERASED',
  'REPORT_NOT_COMPLETE', 'REPORT_REVISION_UNSUPPORTED',
  // R14 replays an identical decision first (0223), so this means the proposal was decided elsewhere (#962 review).
  'REPORT_REVISION_DECIDED']);
/** Failures of a claim that may clear by retrying: they are thrown, and the next continue tries again. */
const TRANSIENT = new Set(['FUSION_ADMISSION_UNAVAILABLE', 'FUSION_REVIEW_UNAVAILABLE', 'FUSION_SETTINGS_UNAVAILABLE',
  'FUSION_GROUP_CONFLICT', 'FUSION_REVIEW_STEP_CONFLICT', 'BILL2_CALL_CONFLICT', 'BILL2_DATABASE_UNAVAILABLE', 'ENTITLEMENTS_UNAVAILABLE',
  'RUNTIME_STAGING_SERVICE_UNAVAILABLE', 'RUNTIME_STAGING_SCHEMA_UNAVAILABLE', 'RUNTIME_STAGING_INTERNAL_ERROR',
  'RUNTIME_STAGING_AUTH_REFRESH_REQUIRED', 'RUNTIME_BILLING_UNIT_UNAVAILABLE', 'RUNTIME_BUDGET_CONFIG_UNAVAILABLE',
  'RUNTIME_PAYG_CONFIG_UNAVAILABLE',
  // A price refresh that failed or is cooling down, and a price configuration still settling, retry like Runtime does.
  'RUNTIME_PRICE_SNAPSHOT_STALE', 'RUNTIME_PRICE_CONFIGURATION_PENDING']);
/** How a failed claim ends its step (#962 review). Every claim goes through one place, and the rule is inverted so a
 * new refusal can never leave a charged review stuck: a size or price bound has its own outcome; any other coded
 * refusal (a setting changed by an administrator, a revoked Skill, a lapsed membership or test window) ends the step
 * as claim_refused; only a listed transient failure or an uncoded error (network, a bug) is thrown for a retry. */
export function claimOutcome(error: unknown): { kind: string; reason?: string } | null {
  const code = error instanceof Error ? error.message : '';
  if (code === 'FUSION_INPUT_TOO_LARGE') return { kind: 'input_too_large' };
  if (code === 'FUSION_ESTIMATE_EXCEEDED' || code === 'FUSION_BUDGET_EXCEEDED') return { kind: 'price_changed' };
  if (!/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(code) || TRANSIENT.has(code)) return null;
  return { kind: 'claim_refused', reason: code };
}
/** The bounds of exactly the members claimed now: a retry of some seats gets only theirs (#962 review). A member
 * without a frozen bound (a phase the estimate did not allow) gets zero, so it can never be claimed. */
export const memberCaps = (caps: Record<string, { credits: number; usd: string }> | undefined, members: FusionMember[]) => {
  if (!caps) return {};
  const own = members.map(member => caps[member.modelId] ?? { credits: 0, usd: '0' });
  const micros = own.reduce((sum, cap) => sum + Math.round(Number(cap.usd) * 1e6), 0);
  return { maxCredits: own.reduce((sum, cap) => sum + cap.credits, 0), maxUsd: (micros / 1e6).toFixed(6) };
};
