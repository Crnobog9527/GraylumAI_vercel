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

const admin = {} as SupabaseClient;
beforeEach(() => { s.calls = []; s.failVerdict = ''; });

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
