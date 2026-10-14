/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * POSITIONING-GATE (Owner 2026-10-12): stable refusal for a user without a confirmed positioning who asks
 * for social media operations on their own account. The front end maps the code to its guide card
 * (start positioning, or import an existing one). No model reply was produced and nothing was charged.
 */
export const POSITIONING_REQUIRED = 'POSITIONING_REQUIRED' as const;
/** Persisted runtime_executions.unavailable_reason when the primary model's fallback refused the turn. */
export const POSITIONING_REQUIRED_REASON = 'positioning_required' as const;
export const POSITIONING_REQUIRED_MESSAGE =
  'POSITIONING_REQUIRED：为自己的账号做社媒运营之前，需要先完成定位，或者导入你已有的定位。本次没有扣积分。';

/** True when an admission refusal (tRPC error message) or a finished turn carries the positioning refusal. */
export function isPositioningRequired(value: { message?: unknown; code?: unknown; unavailable?: unknown } | null | undefined) {
  if (!value) return false;
  return value.code === POSITIONING_REQUIRED || value.unavailable === POSITIONING_REQUIRED_REASON ||
    (typeof value.message === 'string' && value.message.startsWith(POSITIONING_REQUIRED + '：'));
}
