/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createRuntimeBudget } from '../runtime/budget';
import { recoverFusionFinancials } from './recovery';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.parse('2026-10-14T00:00:00Z');
const item = (n: number, dispatched: boolean, minutes: number) => ({ actor_id: id(100), run_id: id(n), call_id: id(n + 50), dispatched,
  dispatch_deadline: new Date(now + minutes * 60_000).toISOString(), recovery: null, created_at: `2026-10-13T00:00:${String(n).padStart(2, '0')}.000001Z` });
function admin(rows: unknown[], options: { deleted?: string[]; failFinalize?: string } = {}) {
  const calls: string[] = [];
  const db = { rpc(name: string, args: Record<string, unknown>) {
    calls.push(`${name}:${String(args.p_run_id ?? '')}`);
    if (name === 'fusion_pending_financial_batch') {
      const after = rows.findIndex(r => (r as { call_id: string }).call_id === args.p_after_id);
      const limit = Number(args.p_limit);
      return Promise.resolve({ data: rows.slice(after + 1, after + 1 + limit), error: null });
    }
    if (name === 'bill2_finalize' && args.p_run_id === options.failFinalize) return Promise.resolve({ data: null, error: { message: 'x' } });
    if (name === 'bill2_read' && args.p_run_id === options.failFinalize)
      return Promise.resolve({ data: { id: args.p_run_id, state: 'unknown', closed: false }, error: null });
    if (name === 'bill2_finalize' || name === 'bill2_read') return Promise.resolve({ data: { id: args.p_run_id, state: 'settled', closed: true,
      contentDeleted: options.deleted?.includes(String(args.p_run_id)) ?? false }, error: null });
    if (name === 'fusion_review_pause_idle') {
      // Like the real query builder: cancellable with an abort signal.
      const result = Promise.resolve({ data: 0, error: null });
      return Object.assign(result, { abortSignal: () => result });
    }
    return Promise.resolve({ data: {}, error: null });
  } };
  return { db: db as unknown as SupabaseClient, calls };
}

describe('Fusion daily recovery', () => {
  it('runs the idle-pause step only with time left before the deadline', async () => {
    const a = admin([]);
    await recoverFusionFinancials(a.db, { now: () => now, budget: createRuntimeBudget() });
    expect(a.calls).toContain('fusion_review_pause_idle:');
    const late = admin([]);
    await recoverFusionFinancials(late.db, { now: () => now, timeLimitMs: 4_000, budget: createRuntimeBudget() });
    expect(late.calls).not.toContain('fusion_review_pause_idle:');
  });
  it('collects expired undispatched calls behind a long backlog of dispatched ones', async () => {
    const backlog = Array.from({ length: 30 }, (_, i) => item(100 + i, true, -60));
    const a = admin([...backlog, item(99, false, -1)]);
    const summary = await recoverFusionFinancials(a.db, { limit: 10, now: () => now, budget: createRuntimeBudget() });
    expect(a.calls.filter(c => c.startsWith('fusion_pending_financial_batch')).length).toBe(4);
    expect(a.calls.findIndex(c => c === `bill2_cancel:${id(99)}`)).toBeLessThan(a.calls.findIndex(c => c === `bill2_finalize:${id(100)}`));
    expect(summary).toMatchObject({ cancelled: 1, recovered: 30 });
  });
  it('cancels expired undispatched calls before slow lookups and stops at the time limit', async () => {
    let clock = now;
    const a = admin([item(20, true, -60), item(21, true, -60), item(22, false, -1)]);
    type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;
    const fake = a.db as unknown as { rpc: Rpc };
    const original = fake.rpc.bind(fake);
    fake.rpc = (name, args) => {
      if (name === 'bill2_finalize') clock += 20_000; // each settle takes 20 s here
      return original(name, args);
    };
    const summary = await recoverFusionFinancials(a.db, { now: () => clock, timeLimitMs: 40_000, budget: createRuntimeBudget() });
    expect(a.calls.findIndex(c => c.startsWith('bill2_cancel'))).toBeLessThan(a.calls.findIndex(c => c === `bill2_finalize:${id(20)}`));
    expect(summary).toMatchObject({ cancelled: 1, deferred: 1, scanned: 2 });
    expect(summary.recovered).toBe(1);
  });
  it('pages past calls that stay pending, so newer calls are reached', async () => {
    const stuck = [item(10, true, -60), item(11, true, -60)];
    const a = admin([...stuck, item(12, false, -1)], { failFinalize: id(10) });
    const summary = await recoverFusionFinancials(a.db, { limit: 2, now: () => now, budget: createRuntimeBudget() });
    expect(summary).toMatchObject({ scanned: 3, cancelled: 1 });
    expect(a.calls).toContain(`bill2_cancel:${id(12)}`);
  });
  it('cancels undispatched calls past their dispatch deadline and leaves fresh ones alone', async () => {
    const a = admin([item(1, false, -1), item(2, false, 5)]);
    const summary = await recoverFusionFinancials(a.db, { now: () => now, budget: createRuntimeBudget() });
    expect(summary).toMatchObject({ success: true, scanned: 2, cancelled: 1, recovered: 0 });
    expect(a.calls).toContain(`bill2_cancel:${id(1)}`);
    expect(a.calls.filter(call => call.endsWith(id(2)))).toEqual([]);
  });
  it('settles dispatched calls and scrubs a settled run whose content was deleted', async () => {
    const a = admin([item(3, true, -60), item(4, true, -60)], { deleted: [id(4)] });
    const summary = await recoverFusionFinancials(a.db, { now: () => now, budget: createRuntimeBudget() });
    expect(summary).toMatchObject({ success: true, recovered: 2, scrubbed: 1 });
    expect(a.calls).toEqual(expect.arrayContaining([`bill2_finalize:${id(3)}`, `account_erasure_scrub_calls:${id(4)}`,
      `account_erasure_scrub_run:${id(4)}`, `account_erasure_scrub_receipts:${id(4)}`]));
    expect(a.calls).not.toContain(`account_erasure_scrub_calls:${id(3)}`);
    expect(a.calls.some(call => call.startsWith('bill2_cancel'))).toBe(false);
  });
  it('reports failures and keeps going', async () => {
    const a = admin([item(5, true, -60), item(6, true, -60)], { failFinalize: id(5) });
    const summary = await recoverFusionFinancials(a.db, { now: () => now, budget: createRuntimeBudget() });
    expect(summary).toMatchObject({ success: false, failed: 1, recovered: 2 });
    expect(a.calls).toContain(`bill2_finalize:${id(6)}`);
    expect((await recoverFusionFinancials({ rpc: async () => ({ data: null, error: { message: 'down' } }) } as unknown as SupabaseClient)).success)
      .toBe(false);
  });
});
