/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * Dispatched PAYG calls whose provider cost never became known after automatic recovery ended
 * (0261). The existing BILL2 rule keeps their hold and hands them to an administrator, who enters
 * the verified provider cost (0 when the provider generated nothing); the call then settles once
 * through the unchanged min(c,U) fallback. Until handled, the daily reconciliation fails so the
 * alert repeats every day. Only content-free evidence is read: statuses, never bodies.
 */
export const STUCK_CALL_REPORT_LIMIT = 100;
const receipt = z.object({ source: z.string().nullable(), httpStatus: z.number().int().nullable(),
  rejectedReason: z.string().nullable(), observedAt: z.string() }).strict();
const stuckCall = z.object({ callId: z.uuid(), runId: z.uuid(), actorId: z.uuid(), model: z.string(),
  phase: z.string().nullable(), upperUsd: z.union([z.string(), z.number()]), reservedCredits: z.number().int().nonnegative(),
  dispatchedAt: z.string(), recoveryDeadline: z.string().nullable(), recoveryAttempts: z.number().int().nonnegative(),
  fusionVerdict: z.string().nullable(), receipts: z.array(receipt) }).strict();
const report = z.object({ total: z.number().int().nonnegative(), calls: z.array(stuckCall).max(STUCK_CALL_REPORT_LIMIT) }).strict();
export type StuckPaygCall = z.infer<typeof stuckCall>;
export type StuckPaygCallReport = { success: boolean; calls: StuckPaygCall[]; total: number; truncated: boolean };

export async function findStuckPaygCalls(supabase: SupabaseClient): Promise<StuckPaygCallReport> {
  const response = await supabase.rpc('bill2_payg_stuck_calls', { p_limit: STUCK_CALL_REPORT_LIMIT });
  if (response.error) throw new Error('BILL2_STUCK_CALLS_SCAN_FAILED');
  const parsed = report.safeParse(response.data);
  if (!parsed.success) throw new Error('BILL2_STUCK_CALLS_SCAN_FAILED');
  // Any stuck call, including ones beyond this page, keeps the reconciliation failing until settled.
  return { success: parsed.data.total === 0, calls: parsed.data.calls, total: parsed.data.total,
    truncated: parsed.data.total > parsed.data.calls.length };
}

export const settleStuckCallInput = z.object({
  callId: z.uuid(), requestId: z.uuid(),
  // A decimal string, as entered from the provider's own record; 0 when it generated nothing.
  verifiedCostUsd: z.string().regex(/^(0|[1-9][0-9]{0,3})(\.[0-9]{1,12})?$/),
  reason: z.string().trim().min(1).max(500),
}).strict();
const settlement = z.object({ callId: z.uuid(), runId: z.uuid(), actorId: z.uuid(),
  verifiedCostUsd: z.union([z.string(), z.number()]), nominalCostUsd: z.union([z.string(), z.number()]).nullable(),
  chargedDelta: z.number().int().nullable(), runState: z.string(), runCharged: z.number().int().nullable(),
  actualRestore: z.number().int().nullable(), creditsBefore: z.number().int().nullable(),
  creditsAfter: z.number().int().nullable(), settledAt: z.string(), auditId: z.uuid() }).strict();

function databaseError(error: unknown): never {
  const message = typeof error === 'object' && error !== null && 'message' in error ? error.message : null;
  if (message === 'BILL2_ADMIN_SETTLE_DENIED') throw new TRPCError({ code: 'FORBIDDEN', message });
  if (message === 'BILL2_ADMIN_SETTLE_CONFLICT' || message === 'BILL2_ADMIN_SETTLE_NOT_READY')
    throw new TRPCError({ code: 'CONFLICT', message });
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'BILL2_ADMIN_SETTLE_UNAVAILABLE' });
}

/** SQL settles and writes the audit record atomically; a repeated request id returns the original result. */
export async function settleStuckCall(db: SupabaseClient, adminId: string, input: z.infer<typeof settleStuckCallInput>) {
  const parsed = settleStuckCallInput.parse(input);
  let response;
  try {
    response = await db.rpc('bill2_payg_admin_settle_call', { p_admin_id: adminId, p_request_id: parsed.requestId,
      p_call_id: parsed.callId, p_verified_cost_usd: parsed.verifiedCostUsd, p_reason: parsed.reason });
  } catch (error) { databaseError(error); }
  if (response.error) databaseError(response.error);
  const result = settlement.safeParse(response.data);
  if (!result.success || result.data.callId !== parsed.callId) databaseError(null);
  return result.data;
}
