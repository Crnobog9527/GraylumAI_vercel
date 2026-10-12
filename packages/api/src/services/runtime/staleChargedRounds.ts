/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * Daily backstop for rounds that ended without an answer for an unclassified Graylum-side
 * reason (Owner 2026-10-12; automatic refunds cover only the fail_platform allow-list).
 * Report-only: lists PAYG rounds still open after 24 hours whose settled calls charged
 * credits and that have no call of unknown outcome (those belong to financial recovery).
 * An operator verifies each one and refunds it with the admin credit adjustment, writing
 * `stale-round:<runId>` in its reason (or idempotency key). The round stays reported, with the
 * credits still owed, until such refunds cover its current uncompensated charges.
 * The billing tables are read only through runtime_stale_charged_rounds (0220).
 */
export const STALE_ROUND_AGE_MS = 24 * 3600 * 1000;
export const STALE_ROUND_REPORT_LIMIT = 100;
export const staleRoundRefundKey = (runId: string) => 'stale-round:' + runId;

const report = z.object({
  total: z.number().int().nonnegative(),
  rounds: z.array(z.object({ executionId: z.string().uuid(), runId: z.string().uuid(),
    chargedCredits: z.number().int().positive(), refundedCredits: z.number().int().nonnegative(),
    outstandingCredits: z.number().int().positive(), since: z.string() }).strict()
    .refine(round => round.chargedCredits - round.refundedCredits === round.outstandingCredits))
    .max(STALE_ROUND_REPORT_LIMIT),
}).strict();
export type StaleChargedRound = {
  kind: 'stale_charged_round'; executionId: string; runId: string; chargedCredits: number;
  refundedCredits: number; outstandingCredits: number; since: string; refundMarker: string;
};
export type StaleChargedRoundReport = { success: boolean; findings: StaleChargedRound[]; total: number; truncated: boolean };

export async function findStaleChargedRounds(supabase: SupabaseClient, now = Date.now()): Promise<StaleChargedRoundReport> {
  const response = await supabase.rpc('runtime_stale_charged_rounds', {
    p_cutoff: new Date(now - STALE_ROUND_AGE_MS).toISOString(), p_limit: STALE_ROUND_REPORT_LIMIT });
  if (response.error) throw new Error('STALE_ROUND_SCAN_FAILED');
  const parsed = report.safeParse(response.data);
  if (!parsed.success) throw new Error('STALE_ROUND_SCAN_FAILED');
  const findings = parsed.data.rounds.map(round => ({ kind: 'stale_charged_round' as const, ...round,
    refundMarker: staleRoundRefundKey(round.runId) }));
  // Any match, including ones beyond this page, keeps the reconciliation failing until handled.
  return { success: parsed.data.total === 0, findings, total: parsed.data.total,
    truncated: parsed.data.total > findings.length };
}
