/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findStaleChargedRounds, STALE_ROUND_AGE_MS, STALE_ROUND_REPORT_LIMIT } from './staleChargedRounds';

// Filtering and permissions are exercised against the real database in staleChargedRounds.integration.ts.
const now = Date.parse('2026-10-13T00:00:00.000Z');
const round = (n: number) => ({ executionId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  runId: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`, chargedCredits: 3, since: '2026-10-11T18:02:00+00:00' });
const client = (result: { data: unknown; error: unknown }) => {
  const rpc = vi.fn(async () => result);
  return { rpc, supabase: { rpc } as unknown as SupabaseClient };
};

it('reads only through the report function with a 24-hour cutoff and marks each finding for the operator refund', async () => {
  const f = client({ data: { total: 1, rounds: [round(1)] }, error: null });
  expect(await findStaleChargedRounds(f.supabase, now)).toEqual({ success: false, total: 1, truncated: false,
    findings: [{ kind: 'stale_charged_round', ...round(1), refundMarker: 'stale-round:' + round(1).runId }] });
  expect(f.rpc).toHaveBeenCalledWith('runtime_stale_charged_rounds', {
    p_cutoff: new Date(now - STALE_ROUND_AGE_MS).toISOString(), p_limit: STALE_ROUND_REPORT_LIMIT });
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
])('fails closed on an unreadable or malformed report %#', async result => {
  await expect(findStaleChargedRounds(client(result).supabase, now)).rejects.toThrow('STALE_ROUND_SCAN_FAILED');
});
