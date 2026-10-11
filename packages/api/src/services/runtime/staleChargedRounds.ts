/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Daily backstop for rounds that ended without an answer for an unclassified Graylum-side
 * reason (Owner 2026-10-12; automatic refunds cover only the fail_platform allow-list).
 * Report-only: lists PAYG rounds still open after 24 hours whose settled calls charged
 * credits and that have no call of unknown outcome (those belong to financial recovery).
 * An operator verifies each one and refunds it with the admin credit adjustment, writing
 * `stale-round:<runId>` in its reason (or idempotency key); that refund removes the round from
 * later reports.
 */
export const STALE_ROUND_AGE_MS = 24 * 3600 * 1000;
export const STALE_ROUND_SCAN_LIMIT = 200;
const OPEN_STATES = ['prepared', 'running', 'interrupted'];
export const staleRoundRefundKey = (runId: string) => 'stale-round:' + runId;

export type StaleChargedRound = {
  kind: 'stale_charged_round'; executionId: string; runId: string; chargedCredits: number;
  since: string; refundMarker: string;
};
export type StaleChargedRoundReport = { success: boolean; findings: StaleChargedRound[]; truncated: boolean };

export async function findStaleChargedRounds(supabase: SupabaseClient, now = Date.now()): Promise<StaleChargedRoundReport> {
  const cutoff = new Date(now - STALE_ROUND_AGE_MS).toISOString();
  const executions = await supabase.from('runtime_executions').select('id,actor_id,billing_run_id,created_at')
    .in('state', OPEN_STATES).lt('created_at', cutoff).not('billing_run_id', 'is', null)
    .order('created_at', { ascending: true }).limit(STALE_ROUND_SCAN_LIMIT);
  if (executions.error) throw new Error('STALE_ROUND_SCAN_FAILED');
  const rows = (executions.data ?? []) as Array<{ id: string; actor_id: string; billing_run_id: string; created_at: string }>;
  const truncated = rows.length === STALE_ROUND_SCAN_LIMIT;
  if (!rows.length) return { success: true, findings: [], truncated };
  const runs = await supabase.from('bill2_runs').select('id').in('id', rows.map(row => row.billing_run_id))
    .eq('contract_version', 'bill2.v2').eq('closed', false);
  if (runs.error) throw new Error('STALE_ROUND_SCAN_FAILED');
  const openRuns = new Set(((runs.data ?? []) as Array<{ id: string }>).map(run => run.id));
  if (!openRuns.size) return { success: true, findings: [], truncated };
  const calls = await supabase.from('bill2_calls').select('run_id,dispatched_at,settled_at,provider_rejected,charged_delta,compensated_at')
    .in('run_id', [...openRuns]);
  if (calls.error) throw new Error('STALE_ROUND_SCAN_FAILED');
  const charged = new Map<string, number>(), unknown = new Set<string>();
  for (const call of (calls.data ?? []) as Array<{ run_id: string; dispatched_at: string | null; settled_at: string | null;
    provider_rejected: boolean; charged_delta: number | null; compensated_at: string | null }>) {
    if (call.dispatched_at && !call.settled_at && !call.provider_rejected) unknown.add(call.run_id);
    if (call.settled_at && !call.compensated_at && (call.charged_delta ?? 0) > 0)
      charged.set(call.run_id, (charged.get(call.run_id) ?? 0) + (call.charged_delta ?? 0));
  }
  const candidates = rows.filter(row => openRuns.has(row.billing_run_id) && !unknown.has(row.billing_run_id)
    && (charged.get(row.billing_run_id) ?? 0) > 0);
  if (!candidates.length) return { success: true, findings: [], truncated };
  // An administrator credit adjustment marked with the round (any administrator) settles its report.
  const refunds = await supabase.from('credit_transactions').select('idempotency_key,description')
    .in('user_id', [...new Set(candidates.map(row => row.actor_id))]).gt('amount', 0)
    .or('idempotency_key.like.admin_adjustment:%stale-round:%,description.like.%stale-round:%');
  if (refunds.error) throw new Error('STALE_ROUND_SCAN_FAILED');
  const marks = ((refunds.data ?? []) as Array<{ idempotency_key: string | null; description: string | null }>)
    .map(row => (row.idempotency_key ?? '') + ' ' + (row.description ?? ''));
  const refunded = (runId: string) => marks.some(mark => mark.includes(staleRoundRefundKey(runId)));
  const findings = candidates.filter(row => !refunded(row.billing_run_id)).map(row => ({
    kind: 'stale_charged_round' as const, executionId: row.id, runId: row.billing_run_id,
    chargedCredits: charged.get(row.billing_run_id)!, since: row.created_at, refundMarker: staleRoundRefundKey(row.billing_run_id),
  }));
  return { success: findings.length === 0, findings, truncated };
}
