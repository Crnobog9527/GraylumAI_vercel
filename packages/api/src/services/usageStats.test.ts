/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { readCreditSummary, readUsageStats, utcMonthStart, UsageStatsReadError } from './usageStats';

const db = (data: unknown, error: { code?: string } | null = null) => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return { calls, rpc: (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return Promise.resolve({ data, error }); } };
};

describe('usage stats read from the database functions', () => {
  it('reads the three counts of one account', async () => {
    const client = db({ conversations: 2, messages: 9, usageDays: 1 });
    await expect(readUsageStats(client, 'u1')).resolves.toEqual({ conversations: 2, messages: 9, usageDays: 1 });
    expect(client.calls).toEqual([{ name: 'usage_stats_for_user', args: { p_user_id: 'u1' } }]);
  });

  it('reads the ledger totals from a start time, or all time', async () => {
    const row = { totalEarned: 5, totalSpent: 3, transactionCount: 4, byType: {}, byLedgerType: { spend: { count: 1, amount: -3 } } };
    const client = db(row);
    await expect(readCreditSummary(client, 'u1', new Date('2026-11-01T00:00:00.000Z'))).resolves.toEqual(row);
    await readCreditSummary(client, 'u1', null);
    expect(client.calls.map((call) => call.args.p_from)).toEqual(['2026-11-01T00:00:00.000Z', null]);
  });

  it.each([
    ['a database error', db(null, { code: '42501' }), '42501'],
    ['a missing result', db(null), null],
    ['a negative count', db({ conversations: -1, messages: 0, usageDays: 0 }), null],
    ['a count that is not a number', db({ conversations: '3', messages: 0, usageDays: 0 }), null],
  ])('refuses %s instead of answering zeros', async (_name, client, code) => {
    await expect(readUsageStats(client, 'u1')).rejects.toMatchObject({ code });
    await expect(readUsageStats(client, 'u1')).rejects.toBeInstanceOf(UsageStatsReadError);
  });

  it('starts the month at 00:00 UTC on the 1st, also in the last hours of a month', () => {
    expect(utcMonthStart(new Date('2026-11-18T09:30:00.000Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(utcMonthStart(new Date('2026-11-30T23:59:59.999Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(utcMonthStart(new Date('2026-12-01T00:00:00.000Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});
