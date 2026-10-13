/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { compensateStaleRound, findStaleChargedRounds, STALE_ROUND_AGE_MS, STALE_ROUND_REPORT_LIMIT } from './staleChargedRounds';

// Filtering, locking, permissions and refunds run against the real database in staleChargedRounds.integration.ts.
const now = Date.parse('2026-10-13T00:00:00.000Z');
const cutoff = new Date(now - STALE_ROUND_AGE_MS).toISOString();
const uuid = (prefix: number, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const evidence = { model: 'synthetic/model', streamed: false, executionState: 'interrupted', unavailableReason: null,
  calls: 1, outputTokens: 4, savedReplyChars: 0, lastActivityAt: '2026-10-11T18:02:31+00:00', lastFinishReason: 'tool_calls' };
const round = (n: number) => ({ executionId: uuid(1, n), runId: uuid(2, n), actorId: uuid(3, n), chargedCredits: 3,
  since: '2026-10-11T18:02:00+00:00', evidence });
const client = (result: { data: unknown; error: unknown }) => {
  const rpc = vi.fn(async () => result);
  return { rpc, supabase: { rpc } as unknown as SupabaseClient };
};

it('reads only through the report function with a 24-hour cutoff', async () => {
  const f = client({ data: { total: 1, rounds: [round(1)] }, error: null });
  expect(await findStaleChargedRounds(f.supabase, now)).toEqual({ success: false, total: 1, truncated: false,
    findings: [{ kind: 'stale_charged_round', ...round(1) }] });
  expect(f.rpc).toHaveBeenCalledWith('runtime_stale_charged_rounds', { p_cutoff: cutoff, p_limit: STALE_ROUND_REPORT_LIMIT });
});

it('keeps failing while matches exceed the page, and passes only with none', async () => {
  expect(await findStaleChargedRounds(client({ data: { total: 150, rounds: [round(1)] }, error: null }).supabase, now))
    .toMatchObject({ success: false, total: 150, truncated: true });
  expect(await findStaleChargedRounds(client({ data: { total: 0, rounds: [] }, error: null }).supabase, now))
    .toEqual({ success: true, findings: [], total: 0, truncated: false });
});

it.each([
  { data: null, error: { code: '42501', message: 'permission denied' } },
  { data: { total: 1 }, error: null },
  { data: { total: 1, rounds: [{ ...round(1), chargedCredits: 0 }] }, error: null },
  { data: { total: 1, rounds: [{ ...round(1), evidence: { ...evidence, outputTokens: -1 } }] }, error: null },
])('fails closed on an unreadable or malformed report %#', async result => {
  await expect(findStaleChargedRounds(client(result).supabase, now)).rejects.toThrow('STALE_ROUND_SCAN_FAILED');
});

it('compensates through the database function with the same cutoff', async () => {
  const outcome = { state: 'compensated', runId: uuid(2, 1), executionId: uuid(1, 1), actorId: uuid(3, 1),
    executionState: 'cancelled', compensatedCredits: 3 };
  const f = client({ data: outcome, error: null });
  expect(await compensateStaleRound(f.supabase, uuid(2, 1), now)).toEqual(outcome);
  expect(f.rpc).toHaveBeenCalledWith('runtime_stale_round_compensate', { p_run_id: uuid(2, 1), p_cutoff: cutoff });
});

it.each([
  ['STALE_ROUND_NOT_ELIGIBLE', { data: null, error: { message: 'STALE_ROUND_NOT_ELIGIBLE' } }],
  ['STALE_ROUND_NOT_FOUND', { data: null, error: { message: 'STALE_ROUND_NOT_FOUND' } }],
  ['STALE_ROUND_COMPENSATION_FAILED', { data: null, error: { message: 'connection reset' } }],
  ['STALE_ROUND_COMPENSATION_FAILED', { data: { state: 'refunded' }, error: null }],
] as const)('reports %s without guessing an outcome', async (code, result) => {
  await expect(compensateStaleRound(client(result).supabase, uuid(2, 1), now)).rejects.toThrow(code);
});
