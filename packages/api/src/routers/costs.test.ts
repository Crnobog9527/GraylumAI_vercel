import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { buildCostOverviewFromRows, buildCostsDashboardFromRows, buildTopUsersFromRows, costsRouter } from './costs';
import { buildCacheEfficiencyFromRows, buildCostTrendFromRows, buildModelDistributionFromRows,
  getCostWindow } from '../services/costReport';

describe('buildCostOverviewFromRows', () => {
  it('preserves a sub-cent USD average instead of rounding it to zero', () => {
    const rows = [
      { total_credits: 1, total_cost_usd: '0.0006', created_at: '2026-03-24T01:00:00.000Z' },
      { total_credits: 1, total_cost_usd: '0.0004', created_at: '2026-03-24T02:00:00.000Z' },
    ];

    expect(buildCostOverviewFromRows(rows, '2026-03-24T00:00:00.000Z', 'usd').avgCostPerCall).toBe(0.0005);
  });

  it('keeps fractional average credits while the recorded total stays integral', () => {
    const rows = [
      { total_credits: 1, total_cost_usd: '0.01', created_at: '2026-03-24T01:00:00.000Z' },
      { total_credits: 0, total_cost_usd: '0', created_at: '2026-03-24T02:00:00.000Z' },
    ];
    expect(buildCostOverviewFromRows(rows, '2026-03-24T00:00:00.000Z', 'credits').avgCostPerCall).toBe(0.5);
  });

  it('derives today and month metrics from one month-scoped dataset', () => {
    const rows = [
      { total_credits: 10, total_cost_usd: '1.5', created_at: '2026-03-24T01:00:00.000Z' },
      { total_credits: 20, total_cost_usd: '2.5', created_at: '2026-03-20T01:00:00.000Z' },
    ];

    const result = buildCostOverviewFromRows(rows, '2026-03-24T00:00:00.000Z', 'usd');

    expect(result.todayCalls).toBe(1);
    expect(result.monthCalls).toBe(2);
    expect(result.todayUsd).toBe(1.5);
    expect(result.monthUsd).toBe(4);
    expect(result.todayCost).toBe(1.5);
    expect(result.monthCost).toBe(4);
  });
});

describe('buildTopUsersFromRows', () => {
  it('aggregates token rows before decorating with profile data', () => {
    const result = buildTopUsersFromRows(
      [
        { user_id: 'user-1', total_credits: 10, total_cost_usd: '1.5' },
        { user_id: 'user-1', total_credits: 5, total_cost_usd: '0.5' },
        { user_id: 'user-2', total_credits: 8, total_cost_usd: '3.0' },
      ],
      [
        { id: 'user-1', email: 'a@example.com', nickname: 'A' },
        { id: 'user-2', email: 'b@example.com', nickname: 'B' },
      ],
      'credits',
      10,
    );

    expect(result).toEqual([
      {
        userId: 'user-1',
        email: 'a@example.com',
        nickname: 'A',
        totalCost: 15,
        totalCalls: 2,
        totalCredits: 15,
        totalUsd: 2,
      },
      {
        userId: 'user-2',
        email: 'b@example.com',
        nickname: 'B',
        totalCost: 8,
        totalCalls: 1,
        totalCredits: 8,
        totalUsd: 3,
      },
    ]);
  });
});

describe('buildCostsDashboardFromRows', () => {
  it('derives overview, trend, distribution, top users and cache efficiency from one shared dataset', () => {
    const result = buildCostsDashboardFromRows(
      [
        {
          user_id: 'user-1',
          model_used: 'gpt-4o-mini',
          total_credits: 10,
          total_cost_usd: '1.5',
          cached_tokens: 100,
          input_tokens: 200,
          created_at: '2026-03-29T08:00:00.000Z',
        },
        {
          user_id: 'user-1',
          model_used: 'gpt-4o-mini',
          total_credits: 20,
          total_cost_usd: '2.5',
          cached_tokens: 0,
          input_tokens: 300,
          created_at: '2026-03-27T08:00:00.000Z',
        },
        {
          user_id: 'user-2',
          model_used: 'claude-3-5-sonnet',
          total_credits: 8,
          total_cost_usd: '3.0',
          cached_tokens: 50,
          input_tokens: 100,
          created_at: '2026-03-20T08:00:00.000Z',
        },
      ],
      [
        { id: 'user-1', email: 'a@example.com', nickname: 'A' },
        { id: 'user-2', email: 'b@example.com', nickname: 'B' },
      ],
      {
        metric: 'usd',
        days: 7,
        limit: 10,
        now: new Date('2026-03-29T12:00:00.000Z'),
        todayStartIso: '2026-03-29T00:00:00.000Z',
        monthStartIso: '2026-03-01T00:00:00.000Z',
      },
    );

    expect(result.overview).toMatchObject({
      todayCalls: 1,
      monthCalls: 3,
      todayUsd: 1.5,
      monthUsd: 7,
    });
    expect(result.trend).toHaveLength(7);
    expect(result.distribution).toEqual([
      expect.objectContaining({ modelId: 'gpt-4o-mini', calls: 2, usd: 4 }),
    ]);
    expect(result.topUsers).toEqual([
      expect.objectContaining({ userId: 'user-1', totalUsd: 4, totalCalls: 2 }),
    ]);
    expect(result.cacheEfficiency).toMatchObject({
      totalRequests: 2,
      cacheHits: 1,
      hitRate: 50,
    });
  });
});

describe('cost report calendar windows', () => {
  it('uses the requested timezone and exactly seven calendar days', () => {
    const now = new Date('2026-03-29T16:30:00.000Z');
    const window = getCostWindow(now, 7, 'Asia/Shanghai');
    expect(window).toEqual({
      rangeStartIso: '2026-03-23T16:00:00.000Z',
      todayStartIso: '2026-03-29T16:00:00.000Z',
      monthStartIso: '2026-02-28T16:00:00.000Z',
    });
    const trend = buildCostTrendFromRows([
      { total_credits: 1, total_cost_usd: '0.0005', created_at: '2026-03-29T16:15:00.000Z' },
    ], 7, 'usd', now, 'Asia/Shanghai');
    expect(trend).toHaveLength(7);
    expect(trend.at(-1)).toMatchObject({ date: '2026-03-30', cost: 0.0005 });
  });

  it('keeps empty windows at zero without adding an eighth day', () => {
    const trend = buildCostTrendFromRows([], 7, 'usd', new Date('2026-03-29T12:00:00.000Z'));
    expect(trend).toHaveLength(7);
    expect(trend.every((day) => day.cost === 0 && day.calls === 0)).toBe(true);
  });
});

describe('cache estimate coverage', () => {
  it('reports unknown BILL2 cache usage as unknown instead of zero savings', () => {
    const result = buildCacheEfficiencyFromRows([{ cached_tokens: null, input_tokens: null,
      total_credits: 1, total_cost_usd: '0.0001' }], 'usd');
    expect(result).toMatchObject({ cacheHits: null, hitRate: null, savedUsd: null, savedValue: null });
  });

  it('keeps a genuine no-cache record at zero', () => {
    const result = buildCacheEfficiencyFromRows([{ cached_tokens: 0, input_tokens: 1,
      total_credits: 1, total_cost_usd: '0.0001' }], 'usd');
    expect(result).toMatchObject({ cacheHits: 0, hitRate: 0, savedUsd: 0, savedValue: 0 });
  });
});

it('labels a BILL2 aggregate as a run summary rather than a single model', () => {
  expect(buildModelDistributionFromRows([{ model_used: 'bill2.aggregate',
    total_credits: 1, total_cost_usd: '0.01' }], 'usd')[0]?.modelName)
    .toBe('BILL2 汇总（非单一模型）');
});

function callerWithAdminClient(admin: unknown, role = 'admin') {
  const scoped = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        single: async () => ({ data: { id: 'admin-user', role, status: 'active',
          nickname: 'Admin', email: 'admin@example.com' }, error: null }),
      };
    },
  };
  return costsRouter.createCaller({
    headers: new Headers(),
    user: { id: 'admin-user', email: 'admin@example.com',
      app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: scoped,
    supabaseAuth: scoped, supabasePublic: {}, supabaseAdmin: admin,
    hasSupabaseAdminPrivileges: true,
  } as any);
}

describe('cost report dashboard query', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  function caller(rows: Array<Record<string, unknown>>, queryError: unknown = null, role = 'admin') {
    const admin = {
      from(table: string) {
        if (table === 'profiles') {
          return {
            select() { return this; },
            in: async () => ({ data: [{ id: 'user-1', email: null, nickname: 'Test' }], error: null }),
          };
        }
        let start = '';
        const builder = {
          select() { return builder; },
          gte(_column: string, value: string) { start = value; return builder; },
          order() { return builder; },
          async range(from: number, to: number) {
            return { data: rows.filter((row) => String(row.created_at) >= start).slice(from, to + 1),
              error: queryError };
          },
        };
        return builder;
      },
    };
    return callerWithAdminClient(admin, role);
  }

  it('sums all pages and keeps a sub-cent average visible to the client', async () => {
    const rows = Array.from({ length: 1001 }, () => ({
      user_id: 'user-1', model_used: 'model-a', total_credits: 1,
      total_cost_usd: '0.000001', cached_tokens: 0, input_tokens: 10,
      created_at: '2026-03-29T08:00:00.000Z',
    }));
    const dashboard = await caller(rows).getDashboard({ days: 7, limit: 10, metric: 'usd' });
    expect(dashboard.overview.monthCalls).toBe(1001);
    expect(dashboard.overview.avgCostPerCall).toBeCloseTo(0.000001, 12);
    expect(dashboard.distribution[0]?.calls).toBe(1001);
    expect(dashboard.topUsers[0]?.totalCalls).toBe(1001);
    expect(dashboard.trend).toHaveLength(7);
  });

  it('reports query failure rather than a fabricated empty report', async () => {
    await expect(caller([], { code: 'PGRST_ERROR' }).getDashboard({ days: 7 }))
      .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('denies non-admin access to report values', async () => {
    await expect(caller([], null, 'user').getDashboard({ days: 7 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects an invalid timezone before querying', async () => {
    await expect(caller([]).getDashboard({ days: 7, timezone: 'Mars/Olympus_Mons' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('cost report usage logs query', () => {
  function usageLogsCaller(rows: Array<Record<string, unknown>>) {
    const calls = { select: '', filters: [] as string[] };
    const builder = {
      select(columns: string) { calls.select = columns; return builder; },
      order() { return builder; },
      range() { return builder; },
      eq(column: string, value: string) { calls.filters.push(`eq:${column}:${value}`); return builder; },
      neq(column: string, value: string) { calls.filters.push(`neq:${column}:${value}`); return builder; },
      then(resolve: (value: unknown) => void) { resolve({ data: rows, count: rows.length, error: null }); },
    };
    return { calls, caller: callerWithAdminClient({ from: () => builder }) };
  }

  it('keeps logs without a profile via a left join and shows them as unknown', async () => {
    const { calls, caller } = usageLogsCaller([{ id: 'log-1', user_id: 'deleted-user',
      model_id: 'model-a', status: 'success', created_at: '2026-03-29T08:00:00.000Z', profiles: null }]);
    const result = await caller.getUsageLogs({});
    expect(calls.select).toMatch(/profiles\s*\(/);
    expect(calls.select).not.toContain('!inner');
    expect(calls.filters).toEqual([]);
    expect(result.logs[0]).toMatchObject({ userId: 'deleted-user', userEmail: 'unknown' });
  });

  it('treats every non-success status as failed', async () => {
    const failed = usageLogsCaller([]);
    await failed.caller.getUsageLogs({ status: 'failed' });
    expect(failed.calls.filters).toEqual(['neq:status:success']);
    const success = usageLogsCaller([]);
    await success.caller.getUsageLogs({ status: 'success' });
    expect(success.calls.filters).toEqual(['eq:status:success']);
  });
});
