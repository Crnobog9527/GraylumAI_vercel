/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { appRouter } from '../root';
import { inferCreditReasonCode, normalizeCreditLedgerType } from '../services/creditLedger';
import { buildFinanceTransactionStats } from '../services/financeReport';
import {
  countsAsCreditSpend,
  getCreditLedgerLabel,
} from '../../../../apps/web/src/components/profile/creditLedgerPresentation';

// Owner 2026-10-26: daily check-in is removed. Existing check-in rows stay valid history.
describe('daily check-in removal', () => {
  it('exposes no check-in procedure to users', () => {
    const procedures = Object.keys(appRouter._def.procedures);
    expect(procedures.filter((name) => name.toLowerCase().includes('checkin'))).toEqual([]);
  });

  it('rejects a direct call to the old claim procedure', async () => {
    const caller = appRouter.createCaller({} as never) as unknown as {
      checkin: { claimDailyCheckin: () => Promise<unknown> };
    };
    await expect(caller.checkin.claimDailyCheckin()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps old check-in rows as granted credits, not unknown or spend', () => {
    const row = { amount: 15, type: 'checkin', description: '每日签到奖励（第3天）' };
    expect(normalizeCreditLedgerType(row)).toBe('grant');
    expect(inferCreditReasonCode(row)).toBe('checkin');
    expect(getCreditLedgerLabel(row)).toBe('积分到账');
    expect(countsAsCreditSpend(row)).toBe(false);
  });

  it('still counts old check-in rows in the finance report', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const stats = buildFinanceTransactionStats(
      [{ type: 'checkin', amount: 25, created_at: '2026-10-25T08:00:00Z' }], [], [], now,
    );
    expect(stats.transactionStats.totalCheckins).toBe(25);
    expect(stats.transactionStats.unknownTypeCount).toBe(0);
  });
});
