/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * Daily backstop for rounds that ended without an answer for an unclassified Graylum-side
 * reason (Owner 2026-10-12; automatic refunds cover only the fail_platform allow-list).
 * The daily reconciliation lists PAYG rounds still open after 24 hours whose settled calls
 * charged credits, with no call of unknown outcome (financial recovery owns those) and not
 * stopped by the user. An operator verifies each one and compensates it from the admin
 * refunds page: the round is closed as a confirmed failure and every charged call is
 * compensated once through bill2_finalize, the same path as fail_platform, so a later retry
 * or automatic failure can never refund it again. The billing tables are read and written
 * only through the 0220 functions.
 */
export const STALE_ROUND_AGE_MS = 24 * 3600 * 1000;
export const STALE_ROUND_REPORT_LIMIT = 100;

const report = z.object({
  total: z.number().int().nonnegative(),
  rounds: z.array(z.object({ executionId: z.string().uuid(), runId: z.string().uuid(), actorId: z.string().uuid(),
    chargedCredits: z.number().int().positive(), since: z.string(),
    // Content-free evidence for the operator's review; never the conversation itself.
    evidence: z.object({ model: z.string().nullable(), streamed: z.boolean(), executionState: z.string(),
      unavailableReason: z.string().nullable(), calls: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(), savedReplyChars: z.number().int().nonnegative(),
      lastActivityAt: z.string().nullable(), lastFinishReason: z.string().max(64).nullable() }).strict(),
  }).strict()).max(STALE_ROUND_REPORT_LIMIT),
}).strict();
export type StaleChargedRound = z.infer<typeof report>['rounds'][number] & { kind: 'stale_charged_round' };
export type StaleChargedRoundReport = { success: boolean; findings: StaleChargedRound[]; total: number; truncated: boolean };
const cutoff = (now: number) => new Date(now - STALE_ROUND_AGE_MS).toISOString();

export async function findStaleChargedRounds(supabase: SupabaseClient, now = Date.now()): Promise<StaleChargedRoundReport> {
  const response = await supabase.rpc('runtime_stale_charged_rounds', { p_cutoff: cutoff(now), p_limit: STALE_ROUND_REPORT_LIMIT });
  if (response.error) throw new Error('STALE_ROUND_SCAN_FAILED');
  const parsed = report.safeParse(response.data);
  if (!parsed.success) throw new Error('STALE_ROUND_SCAN_FAILED');
  const findings = parsed.data.rounds.map(round => ({ kind: 'stale_charged_round' as const, ...round }));
  // Any match, including ones beyond this page, keeps the reconciliation failing until handled.
  return { success: parsed.data.total === 0, findings, total: parsed.data.total,
    truncated: parsed.data.total > findings.length };
}

const compensation = z.object({
  state: z.enum(['compensated', 'already_compensated']), runId: z.string().uuid(), executionId: z.string().uuid(),
  actorId: z.string().uuid(),
  executionState: z.string(), compensatedCredits: z.number().int().nonnegative(),
}).strict();
export type StaleRoundCompensation = z.infer<typeof compensation>;
export const STALE_ROUND_REFUSALS = ['STALE_ROUND_NOT_FOUND', 'STALE_ROUND_NOT_ELIGIBLE'] as const;

/** Operator action after verifying a reported round. Idempotent; refuses rounds no longer eligible. */
export async function compensateStaleRound(supabase: SupabaseClient, runId: string, now = Date.now()): Promise<StaleRoundCompensation> {
  const response = await supabase.rpc('runtime_stale_round_compensate', { p_run_id: runId, p_cutoff: cutoff(now) });
  if (response.error) {
    const message = response.error.message ?? '';
    throw new Error(STALE_ROUND_REFUSALS.find(code => message.includes(code)) ?? 'STALE_ROUND_COMPENSATION_FAILED');
  }
  const parsed = compensation.safeParse(response.data);
  if (!parsed.success) throw new Error('STALE_ROUND_COMPENSATION_FAILED');
  return parsed.data;
}
