/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, vi } from 'vitest';
import { readMethodMembership } from './methodMembership';
function fixture(counts: Array<number | null> = [40, 3, 2]) {
  const results = [{ data: null, error: null }, { data: [], error: null },
    ...counts.map(count => ({ count, data: null, error: null }))];
  const queries: Array<{ eq: ReturnType<typeof vi.fn>; not: ReturnType<typeof vi.fn> }> = [];
  const from = vi.fn(() => {
    const result = results.shift();
    const query = { select: vi.fn(), eq: vi.fn(), not: vi.fn(), gt: vi.fn(), is: vi.fn(), order: vi.fn(), limit: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue(result),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
    for (const method of ['select', 'eq', 'not', 'gt', 'is', 'order', 'limit'] as const) query[method].mockReturnValue(query);
    queries.push(query); return query;
  });
  return { db: { from } as unknown as SupabaseClient, queries };
}
describe('method membership read projection', () => {
  it('uses real sold/reserved/review counts across channels; remains closed', async () => {
    const f = fixture(); const result = await readMethodMembership(f.db, 'actor', 1791676800000);
    expect(result.founder).toEqual({ total: 50, sold: 40, reserved: 5, available: 5 });
    expect(result.checkoutReady).toBe(false);
    expect(f.queries[1]?.eq).toHaveBeenCalledWith('user_id', 'actor');
    expect(f.queries[1]?.eq).toHaveBeenCalledWith('payment_status', 'paid');
    expect(f.queries[1]?.not).toHaveBeenCalledWith('fulfilled_at', 'is', null);
    for (const q of f.queries.slice(2)) {
      expect(q.eq).toHaveBeenCalledWith('payment_mode', 'test');
      expect(q.eq).not.toHaveBeenCalledWith('merchant_namespace', expect.anything());
      expect(q.eq).not.toHaveBeenCalledWith('payment_status', expect.anything());
    }
  });
  it('does not present missing count as zero or hide oversold state', async () => {
    await expect(readMethodMembership(fixture([null, 0, 0]).db, 'actor')).rejects.toThrow('PAY_WAFFO_MEMBERSHIP_UNAVAILABLE');
    await expect(readMethodMembership(fixture([50, 1, 0]).db, 'actor')).rejects.toThrow('PAY_WAFFO_FOUNDER_CAPACITY_CONFLICT');
  });
});
