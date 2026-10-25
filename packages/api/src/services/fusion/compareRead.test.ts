/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const s = vi.hoisted(() => ({ calls: [] as string[], failVerdict: '' }));
vi.mock('./compareAdmission', () => ({
  compareRpc: async (_admin: unknown, name: string, args: Record<string, unknown>) => {
    s.calls.push(name === 'fusion_call_verdict' ? `verdict:${String(args.p_call_id)}` : name);
    if (name === 'fusion_compare_read') return { state: 'running', columns: [0, 1].map(i => ({ column: i, runId: id(10 + i), body: '回答',
      call: { callId: id(20 + i), verdict: null, inFlight: true } })) };
    if (name === 'fusion_call_verdict' && (s.failVerdict === 'all' || args.p_call_id === s.failVerdict)) throw new Error('FUSION_ADMISSION_UNAVAILABLE');
    return {};
  },
}));
import { readCompare } from './compareLive';
import { setLogSink, type LogSink } from '../../lib/logger';

const admin = {} as SupabaseClient;
const logged: Array<Parameters<LogSink>[0]> = [];
beforeEach(() => { s.calls = []; s.failVerdict = ''; logged.length = 0; setLogSink(entry => { logged.push(entry); }); });

describe('compare read repairs an interrupted column (FUSION-COMPARE §3.5)', () => {
  // inFlight is true in these fixtures on purpose: it means dispatched and unsettled, which is exactly an interrupted answer.
  it('judges saved, unjudged answers usable and settles each judged run', async () => {
    const settled: string[] = [];
    await readCompare(admin, id(1), id(2), async () => async (runId: string) => { settled.push(runId); });
    expect(s.calls.filter(c => c.startsWith('verdict:'))).toEqual([`verdict:${id(20)}`, `verdict:${id(21)}`]);
    expect(settled).toEqual([id(10), id(11)]);
  });
  it('never settles a column whose verdict write failed: it stays open for the daily recovery', async () => {
    s.failVerdict = id(21);
    const settled: string[] = [];
    await readCompare(admin, id(1), id(2), async () => async (runId: string) => { settled.push(runId); });
    expect(settled).toEqual([id(10)]);
  });
  it('does not open the billing path at all when no verdict could be written', async () => {
    s.failVerdict = 'all';
    const open = vi.fn(async () => async () => undefined);
    await readCompare(admin, id(1), id(2), open);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('a failed compare settlement is never answered as done (MAINT-P3 / audit A3)', () => {
  it('lists the run as pending settlement, logs it, and leaves it to the daily recovery', async () => {
    const settled: string[] = [];
    const view = await readCompare(admin, id(1), id(2), async () => async (runId: string) => {
      if (runId === id(11)) throw new Error('BILL2_DATABASE_UNAVAILABLE');
      settled.push(runId);
    });
    expect(settled).toEqual([id(10)]);
    expect(view?.settlementPending).toEqual([id(11)]);
    expect(logged).toEqual([{ level: 'warn', category: 'billing', message: 'fusion_compare_settle_failed' }]);
  });
  it('an unavailable billing path (window closed, database down) leaves every judged run pending, logged once', async () => {
    const view = await readCompare(admin, id(1), id(2), async () => { throw new Error('RUNTIME_STAGING_SERVICE_UNAVAILABLE'); });
    expect(view?.settlementPending).toEqual([id(10), id(11)]);
    expect(logged.map(entry => entry.message)).toEqual(['fusion_compare_settle_unavailable']);
  });
  it('a successful settlement adds no marker and logs nothing; a failed verdict repair is logged', async () => {
    expect((await readCompare(admin, id(1), id(2), async () => async () => undefined))?.settlementPending).toBeUndefined();
    expect(logged).toEqual([]);
    s.failVerdict = 'all';
    await readCompare(admin, id(1), id(2), async () => async () => undefined);
    expect(logged.map(entry => entry.message)).toEqual(['fusion_compare_verdict_repair_failed', 'fusion_compare_verdict_repair_failed']);
  });
});
