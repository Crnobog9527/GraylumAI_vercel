import { describe, expect, it } from 'vitest';
import { buildCostOverviewFromRows, buildCostsDashboardFromRows, buildTopUsersFromRows } from './costs';

describe('buildCostOverviewFromRows', () => {
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
