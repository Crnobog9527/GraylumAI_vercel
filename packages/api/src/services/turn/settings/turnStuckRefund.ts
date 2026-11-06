/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../../lib/logger';

/**
 * RECONCILE (b): turns whose credit freeze can stay for ever (an unknown model cost whose lookup never answers, or a turn nobody
 * closed). turn_admin_stuck_turns counts the turns opened 24 hours ago or more that are not closed (and idle for 24 hours), or closed with
 * the user's charge still undecided, or closed with the settlement still pending 48 hours after the close (the user already charged); turn_admin_refund_all is the admin action that settles them (the whole freeze returns, once, audit-logged).
 * Both are SECURITY DEFINER functions for the service role (migration turn_admin_refund_all).
 */
const count = z.number().int().nonnegative();
const stuck = z.object({ total: count, oldestOpenedAt: z.string().nullable() }).strict();
const REFUSAL_REASONS = ['already_settled', 'too_young', 'not_pending'] as const;
const refundResult = z.union([
  z.object({ refunded: z.literal(true), turnId: z.number().int(), chargedCredits: count, reservedCredits: count, closeKind: z.string().nullable(),
    settlement: z.string().nullable(), stateBefore: z.string() }).strict(),
  z.object({ refunded: z.literal(false), reason: z.enum(REFUSAL_REASONS), turnId: z.number().int(), chargedCredits: count.optional() }).strict(),
]);
export type StuckTurnRefund = z.infer<typeof refundResult>;
export const STUCK_TURN_ALERT_CODE = 'turn_unsettled_over_24h';
const HOUR_MS = 60 * 60 * 1000;

/** What the daily billing-reconcile run reads: how many turns have a freeze that may never end, and the oldest one's age. A scan that
 * cannot be read is a failure, never "none". */
export async function stuckTurnScan(supabase: Pick<SupabaseClient, 'rpc'>, now = new Date()) {
  const { data, error } = await supabase.rpc('turn_admin_stuck_turns');
  const parsed = stuck.safeParse(data);
  if (error || !parsed.success) {
    logger.warn('billing', 'turn_stuck_scan_unavailable', { code: error?.code ?? 'invalid_shape' });
    return { success: false as const, available: false as const, count: 0, oldestAgeHours: 0 };
  }
  const opened = parsed.data.oldestOpenedAt ? Date.parse(parsed.data.oldestOpenedAt) : NaN;
  const oldestAgeHours = Number.isFinite(opened) ? Math.max(0, Math.floor((now.getTime() - opened) / HOUR_MS)) : 0;
  if (parsed.data.total > 0) {
    // A fixed code (API_BILLING_TURN_UNSETTLED_OVER_24H in Sentry) so an alert rule can target it; the numbers stay in the log.
    logger.error('billing', STUCK_TURN_ALERT_CODE, { count: parsed.data.total, oldestAgeHours });
  }
  return { success: parsed.data.total === 0, available: true as const, count: parsed.data.total, oldestAgeHours };
}

export class StuckTurnRefundError extends Error {
  constructor(readonly code: 'TURN_DENIED' | 'TURN_ADMIN_DENIED' | 'TURN_REFUND_INCOMPLETE' | 'TURN_REFUND_FAILED') { super(code); }
}

/** The admin action "按回合全额退回并关闭". A younger or already settled turn is refused with its reason (nothing written); a repeat
 * returns the first outcome. */
export async function refundStuckTurn(
  supabase: Pick<SupabaseClient, 'rpc'>,
  input: { actorId: string; turnId: number; adminId: string; requestId: string; reason?: string | null },
): Promise<StuckTurnRefund> {
  const { data, error } = await supabase.rpc('turn_admin_refund_all', {
    p_actor_id: input.actorId, p_turn_id: input.turnId, p_admin_id: input.adminId, p_request_id: input.requestId,
    p_reason: input.reason ?? null,
  });
  if (error) {
    const message = error.message ?? '';
    const known = (['TURN_ADMIN_DENIED', 'TURN_DENIED', 'TURN_REFUND_INCOMPLETE'] as const).find(code => message.includes(code));
    logger.warn('billing', 'turn_admin_refund_failed', { code: known ?? error.code ?? 'unknown' });
    throw new StuckTurnRefundError(known ?? 'TURN_REFUND_FAILED');
  }
  const parsed = refundResult.safeParse(data);
  if (!parsed.success) throw new StuckTurnRefundError('TURN_REFUND_FAILED');
  return parsed.data;
}
