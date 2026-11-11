/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  AdminActivityReadError, readAdminActivity, readAdminDashboardStats, readUsageDays, requestCount, sumDaysSince, usageDaysAsTokenRows,
} from './adminActivity';

type Call = { name: string; args: Record<string, unknown>; ranges: Array<[number, number]> };
/** An admin client whose function answers `pages` in turn (a set-returning function is read page by page). */
function db(pages: unknown[], error: { code?: string } | null = null) {
  const calls: Call[] = [];
  let page = 0;
  return {
    calls,
    rpc(name: string, args: Record<string, unknown>) {
      const call: Call = { name, args, ranges: [] };
      calls.push(call);
      const builder = {
        order: () => builder,
        range: (from: number, to: number) => { call.ranges.push([from, to]); return builder; },
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: error ? null : pages[Math.min(page++, pages.length - 1)], error }).then(onFulfilled, onRejected),
      };
      return builder;
    },
  };
}
const day = (model: string, date: string | null, requests = 1) => ({
  model_used: model, day: date, requests, total_credits: 2 * requests, total_cost_usd: '0.01',
  input_tokens: 10, output_tokens: 5, cached_tokens: null, cache_creation_tokens: null,
});
const activity = {
  conversations: { total: 2, byModel: [{ model: 'm', count: 2 }], days: [{ date: '2026-11-17', model: 'm', count: 1 }] },
  messages: { user: 3, assistant: 3, days: [{ date: '2026-11-17', user: 1, assistant: 1 }] },
  calls: { finished: 4, failed: 1, avgMs: 2100, p95Ms: 9000 },
};
const dashboard = {
  users: { total: 5, today: 1, week: 2, month: 3, credits: 900 }, tickets: { total: 1, open: 1, inProgress: 0, closed: 0 },
  ledger: { byType: { consumption: { count: 2, amount: -9 } }, spent: 9, days: [{ date: '2026-11-17', granted: 0, spent: 9 }] },
};
const at = (iso: string) => new Date(iso);

describe('admin activity read from the database functions', () => {
  it('reads usage days page by page, from the beginning when no start is given', async () => {
    const full = Array.from({ length: 500 }, (_, index) => day(`m${index}`, '2026-11-17'));
    const client = db([full, [day('z', null, 7)]]);
    const rows = await readUsageDays(client, null, at('2026-11-18T00:00:00Z'), at('2026-10-19T00:00:00Z'));
    expect(rows).toHaveLength(501);
    expect(client.calls.map(call => call.ranges)).toEqual([[[0, 499]], [[500, 999]]]);
    expect(client.calls[0]!.args).toEqual({ p_from: null, p_to: '2026-11-18T00:00:00.000Z', p_daily_from: '2026-10-19T00:00:00.000Z' });
  });

  it('reads the activity and the dashboard summary with their windows', async () => {
    const one = db([activity]);
    await expect(readAdminActivity(one, at('2026-11-11T00:00:00Z'), at('2026-11-18T00:00:00Z'), at('2026-11-15T00:00:00Z'))).resolves.toEqual(activity);
    expect(one.calls[0]).toMatchObject({ name: 'turn_admin_activity',
      args: { p_from: '2026-11-11T00:00:00.000Z', p_to: '2026-11-18T00:00:00.000Z', p_calls_from: '2026-11-15T00:00:00.000Z' } });
    // Without a separate start the calls cover the same window.
    await readAdminActivity(one, at('2026-11-11T00:00:00Z'), at('2026-11-18T00:00:00Z'));
    expect(one.calls[1]!.args.p_calls_from).toBe('2026-11-11T00:00:00.000Z');
    const two = db([dashboard]);
    await expect(readAdminDashboardStats(two, at('2026-11-18T00:00:00Z'), at('2026-11-11T09:00:00Z'), at('2026-11-01T00:00:00Z')))
      .resolves.toEqual(dashboard);
    expect(two.calls[0]!.args).toEqual({ p_today: '2026-11-18T00:00:00.000Z', p_week: '2026-11-11T09:00:00.000Z', p_month: '2026-11-01T00:00:00.000Z' });
  });

  it.each([
    ['a database error', () => readUsageDays(db([[]], { code: '42501' }), null, at('2026-11-18T00:00:00Z'), at('2026-11-01T00:00:00Z')), '42501'],
    ['usage days that are not a list', () => readUsageDays(db([{ model_used: 'm' }]), null, at('2026-11-18T00:00:00Z'), at('2026-11-01T00:00:00Z')), null],
    ['a usage day with a negative count', () => readUsageDays(db([[{ ...day('m', '2026-11-17'), requests: -1 }]]), null, at('2026-11-18T00:00:00Z'), at('2026-11-01T00:00:00Z')), null],
    ['an activity without its calls', () => readAdminActivity(db([{ ...activity, calls: undefined }]), at('2026-11-11T00:00:00Z'), at('2026-11-18T00:00:00Z')), null],
    ['an empty activity answer', () => readAdminActivity(db([null]), at('2026-11-11T00:00:00Z'), at('2026-11-18T00:00:00Z')), null],
    ['a dashboard error', () => readAdminDashboardStats(db([null], { code: '57014' }), at('2026-11-18T00:00:00Z'), at('2026-11-11T00:00:00Z'), at('2026-11-01T00:00:00Z')), '57014'],
  ])('refuses %s instead of answering zeros', async (_name, read, code) => {
    await expect(read()).rejects.toBeInstanceOf(AdminActivityReadError);
    await expect(read()).rejects.toMatchObject({ code });
  });

  it('turns usage days into token rows that carry their request count; a folded row is older than any chart', () => {
    const rows = usageDaysAsTokenRows([day('m', '2026-11-17', 3), day('m', null, 40)]);
    expect(rows.map(row => [row.created_at, row.requests, row.total_credits])).toEqual([
      ['2026-11-17T00:00:00.000Z', 3, 6], ['1970-01-01T00:00:00.000Z', 40, 80],
    ]);
    expect(rows[0]).toMatchObject({ model_used: 'm', total_cost_usd: '0.01', input_tokens: 10, cached_tokens: null });
    // A row of the retired path has no count and is one request.
    expect(requestCount([...rows, { requests: undefined }, {}])).toBe(45);
  });

  it('sums day rows from the UTC day of a moment on', () => {
    const days = [{ date: '2026-11-10', n: 1 }, { date: '2026-11-11', n: 2 }, { date: '2026-11-12', n: 4 }];
    expect(sumDaysSince(days, at('2026-11-11T23:59:59Z'), row => row.n)).toBe(6);
    expect(sumDaysSince(days, at('2026-11-12T00:00:00Z'), row => row.n)).toBe(4);
    expect(sumDaysSince([], at('2026-11-12T00:00:00Z'), () => 1)).toBe(0);
  });
});
