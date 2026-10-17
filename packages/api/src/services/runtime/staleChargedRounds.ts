/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { BillingRpc } from '../bill2/service';
import { logger } from '../../lib/logger';

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
 * Once the runtime-recovery job runs on a schedule, it applies the same rule and the same function
 * without a person (Owner 2026-10-12 supplement), so the two paths together refund a round once.
 * Content beyond capacity is user-side: the executor marks it (0283) and neither path refunds it.
 * Rounds created before markers were reliable stay with the operator (the automatic close skips them).
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
  }).strict()).max(500),
}).strict();
export type StaleChargedRound = z.infer<typeof report>['rounds'][number] & { kind: 'stale_charged_round' };
export type StaleChargedRoundReport = { success: boolean; findings: StaleChargedRound[]; total: number; truncated: boolean };
const cutoff = (now: number) => new Date(now - STALE_ROUND_AGE_MS).toISOString();

export async function findStaleChargedRounds(supabase: BillingRpc, now = Date.now(), limit = STALE_ROUND_REPORT_LIMIT,
  createdSince?: string): Promise<StaleChargedRoundReport> {
  const response = await supabase.rpc('runtime_stale_charged_rounds', { p_cutoff: cutoff(now), p_limit: limit,
    ...(createdSince ? { p_created_since: createdSince } : {}) });
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
export async function compensateStaleRound(supabase: BillingRpc, runId: string, now = Date.now()): Promise<StaleRoundCompensation> {
  const response = await supabase.rpc('runtime_stale_round_compensate', { p_run_id: runId, p_cutoff: cutoff(now) });
  if (response.error) {
    const message = String((response.error as { message?: unknown }).message ?? '');
    throw new Error(STALE_ROUND_REFUSALS.find(code => message.includes(code)) ?? 'STALE_ROUND_COMPENSATION_FAILED');
  }
  const parsed = compensation.safeParse(response.data);
  if (!parsed.success) throw new Error('STALE_ROUND_COMPENSATION_FAILED');
  return parsed.data;
}

export type StaleRoundAutoClose = {
  found: number; compensated: number; alreadyCompensated: number; skipped: number; failed: number; credits: number;
  /** Rounds created before capacity markers were reliable (0283): ambiguous, left to an operator. */
  manualReview: number;
  /** Reported rounds not attempted because the time budget ran out (including those past the report page). */
  deferred: number;
};

/** runtime-recovery: closes and refunds each reported round through the operator function. A round an
 * operator refunded meanwhile, or one a retry revived, is not a failure; an unknown result is, and is
 * retried on the next run (the function is idempotent). Rounds past the time budget wait for the next run and are
 * counted as `deferred`, which fails the job. Rounds created before the capacity marker was reliable are left to
 * the operator (`manualReview`; the daily reconciliation keeps listing them). */
export async function autoCompensateStaleRounds(supabase: BillingRpc,
  options: { now?: number; canStart?: () => boolean } = {}): Promise<StaleRoundAutoClose> {
  const now = options.now ?? Date.now();
  const summary: StaleRoundAutoClose = { found: 0, compensated: 0, alreadyCompensated: 0, skipped: 0, failed: 0, credits: 0, manualReview: 0, deferred: 0 };
  let report: StaleChargedRoundReport, all: StaleChargedRoundReport;
  try {
    const marker = await supabase.rpc('runtime_capacity_marker_since', {});
    if (marker.error) throw new Error('STALE_ROUND_MARKER_UNREADABLE');
    let value = marker.data;
    if (value === null) {
      // First run of the application version that writes the markers: start the clock now (write-once). Nothing is
      // refunded by this run, and nothing created before the armed time ever is: only an operator refunds those.
      const armed = await supabase.rpc('runtime_capacity_marker_arm', {});
      if (armed.error) throw new Error('STALE_ROUND_MARKER_UNREADABLE');
      value = null;
    }
    const since = typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    // Eligible rounds are selected in SQL before the page limit, so older ambiguous rounds cannot crowd them out.
    all = await findStaleChargedRounds(supabase, now, 1);
    report = since ? await findStaleChargedRounds(supabase, now, 500, since) : { success: true, findings: [], total: 0, truncated: false };
  } catch { summary.failed++; return summary; }
  summary.found = all.total;
  // A round from before markers existed may be a capacity failure with no trace: never refund it unseen.
  summary.manualReview = Math.max(0, all.total - report.total);
  const eligible = report.findings;
  let attempted = 0;
  for (const round of eligible) {
    if (options.canStart && !options.canStart()) break;
    attempted++;
    try {
      const outcome = await compensateStaleRound(supabase, round.runId, now);
      if (outcome.state === 'already_compensated') { summary.alreadyCompensated++; continue; }
      summary.compensated++;
      summary.credits += outcome.compensatedCredits;
      logger.info('billing', 'runtime_stale_round_auto_compensated', { runId: outcome.runId,
        executionId: outcome.executionId, actorId: outcome.actorId, credits: outcome.compensatedCredits });
    } catch (error) {
      if (STALE_ROUND_REFUSALS.some(code => error instanceof Error && error.message === code)) summary.skipped++;
      else summary.failed++;
    }
  }
  // Known refunds left undone must not look like success: the job alerts until a run finishes them.
  summary.deferred = Math.max(0, report.total - attempted);
  return summary;
}
