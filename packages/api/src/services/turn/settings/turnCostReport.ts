/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../../lib/logger';

/** Admin finance views on the core-path tables, read through two read-only functions (turn_admin_model_report,
 * turn_admin_unsettled_turns). Unknown costs stay unknown: a call without a recorded cost is counted, never summed as 0. */
const usd = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);
const count = z.number().int().nonnegative();
const modelReport = z.object({
  models: z.array(z.object({ model: z.string(), calls: count, unknownCostCalls: count, unknownActualCalls: count, nominalUsd: usd, actualUsd: usd,
    minMultiplier: z.string().nullable(), maxMultiplier: z.string().nullable() }).strict()),
  byDate: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), calls: count, unknownCostCalls: count, nominalUsd: usd }).strict()),
  totals: z.object({ calls: count, unknownCostCalls: count, unknownActualCalls: count, nominalUsd: usd, actualUsd: usd, turns: count,
    chargedCredits: count, absorbedCredits: count, unsettledTurns: count }).strict(),
}).strict();
const unsettled = z.object({
  total: count,
  turns: z.array(z.object({ turnId: z.number().int(), actorId: z.string().uuid(), kind: z.string(), state: z.string(),
    settlement: z.string().nullable(), closeKind: z.string().nullable(), openedAt: z.string(), updatedAt: z.string(),
    reservedCredits: count, chargedCredits: count.nullable(), failureCode: z.string().nullable(), inFlightCalls: count,
    costPendingCalls: count }).strict()).max(200),
}).strict();
// turn_admin_absent_refunds: the unknown model calls settled at zero because the provider answered "no such generation" (Owner 2026-11-03).
const absentRefunds = z.object({
  total: count,
  calls: z.array(z.object({ turnId: z.number().int(), seq: z.number().int(), actorId: z.string().uuid(), kind: z.string(),
    source: z.enum(['lookup_absent', 'no_identity_24h']), providerId: z.string().nullable(),
    httpStatus: z.number().int().nullable(), settledAt: z.string(), openedAt: z.string(), reservedCredits: count, chargedCredits: count.nullable(),
    settlement: z.string().nullable(), state: z.string() }).strict()).max(200),
}).strict();
export type TurnModelReport = z.infer<typeof modelReport>;
export type UnsettledTurnReport = z.infer<typeof unsettled>;

export async function turnModelReport(supabase: Pick<SupabaseClient, 'rpc'>, from: Date, to: Date) {
  const { data, error } = await supabase.rpc('turn_admin_model_report', { p_from: from.toISOString(), p_to: to.toISOString() });
  const parsed = modelReport.safeParse(data);
  // Until the function is applied or if it fails, the report is unavailable, not empty.
  if (error || !parsed.success) {
    logger.warn('billing', 'turn_model_report_unavailable', { code: error?.code ?? 'invalid_shape' });
    return { available: false as const, from: from.toISOString(), to: to.toISOString() };
  }
  return { available: true as const, from: from.toISOString(), to: to.toISOString(), ...parsed.data };
}

export async function unsettledTurns(supabase: Pick<SupabaseClient, 'rpc'>) {
  const { data, error } = await supabase.rpc('turn_admin_unsettled_turns', { p_limit: 100 });
  const parsed = unsettled.safeParse(data);
  if (error || !parsed.success) {
    logger.warn('billing', 'turn_unsettled_unavailable', { code: error?.code ?? 'invalid_shape' });
    return { available: false as const };
  }
  return { available: true as const, ...parsed.data };
}

/** Read-only: every unknown call settled at zero on the provider's "not found" answer, newest first, so each refund stays on record. */
export async function absentRefundCalls(supabase: Pick<SupabaseClient, 'rpc'>) {
  const { data, error } = await supabase.rpc('turn_admin_absent_refunds', { p_limit: 100 });
  const parsed = absentRefunds.safeParse(data);
  if (error || !parsed.success) {
    logger.warn('billing', 'turn_absent_refunds_unavailable', { code: error?.code ?? 'invalid_shape' });
    return { available: false as const };
  }
  return { available: true as const, ...parsed.data };
}
