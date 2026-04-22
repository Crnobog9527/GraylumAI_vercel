/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it, vi } from 'vitest';

import { applyInvitationRebateForSpend } from '../invitationRebate';

function createMockSupabase(options?: {
  settings?: Array<{ key: string; value: unknown }>;
  invitationRecord?: Record<string, unknown> | null;
  invitationRecordError?: { message: string } | null;
  existingRebate?: Record<string, unknown> | null;
  inviterCredits?: number;
  directTodayRewards?: number[];
  directTotalRewards?: number[];
  rebateTodayRewards?: number[];
  rebateTotalRewards?: number[];
}) {
  const settings = options?.settings ?? [
    { key: 'invite_rebate_percent', value: 5 },
    { key: 'invite_binding_days', value: 30 },
    { key: 'invite_daily_reward_limit', value: 1000 },
    { key: 'invite_total_reward_limit', value: 50000 },
    { key: 'invite_inviter_reward', value: 50 },
    { key: 'invite_invitee_reward', value: 30 },
    { key: 'new_user_credits', value: 100 },
    { key: 'invite_monthly_count_limit', value: 50 },
    { key: 'invite_same_ip_hour_limit', value: 3 },
    { key: 'invite_same_ip_day_limit', value: 5 },
    { key: 'invite_risk_auto_reject', value: true },
  ];

  const invitationRecord = options && 'invitationRecord' in options
    ? options.invitationRecord
    : {
        id: 'invite-record-1',
        inviter_id: 'inviter-1',
        invitee_email: 'invitee@example.com',
        created_at: '2026-03-09T12:00:00.000Z',
      };

  const directTodayRewards = options?.directTodayRewards ?? [50];
  const directTotalRewards = options?.directTotalRewards ?? [50, 50];
  const rebateTodayRewards = options?.rebateTodayRewards ?? [];
  const rebateTotalRewards = options?.rebateTotalRewards ?? [];
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];

  const responseQueue = [
    { data: settings, error: null },
    { data: invitationRecord, error: options?.invitationRecordError ?? null },
    { data: options?.existingRebate ?? null, error: null },
    { data: directTodayRewards.map((value) => ({ inviter_reward: value })), error: null },
    { data: directTotalRewards.map((value) => ({ inviter_reward: value })), error: null },
    { data: rebateTodayRewards.map((value) => ({ amount: value })), error: null },
    { data: rebateTotalRewards.map((value) => ({ amount: value })), error: null },
    { data: { credits: options?.inviterCredits ?? 100 }, error: null },
    { data: null, error: null },
    { data: null, error: null },
  ];

  return {
    updates,
    inserts,
    from: vi.fn((table: string) => {
      const builder: any = {
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockImplementation(() => Promise.resolve(responseQueue.shift())),
        single: vi.fn().mockImplementation(() => Promise.resolve(responseQueue.shift())),
        update: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          updates.push({ table, values });
          return builder;
        }),
        insert: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          inserts.push({ table, values });
          return Promise.resolve(responseQueue.shift());
        }),
        then: (onFulfilled: (value: unknown) => unknown) => Promise.resolve(onFulfilled(responseQueue.shift())),
      };

      return builder;
    }),
  } as any;
}

describe('applyInvitationRebateForSpend', () => {
  it('applies rebate to the inviter when an invitee spends inside the binding window', async () => {
    const supabase = createMockSupabase();

    const result = await applyInvitationRebateForSpend({
      supabase,
      inviteeId: 'invitee-1',
      consumedCredits: 200,
      preDeductId: 'pre-123',
      now: new Date('2026-03-10T12:00:00.000Z'),
    });

    expect(result).toEqual({
      status: 'applied',
      rebateCredits: 10,
      inviterId: 'inviter-1',
      invitationRecordId: 'invite-record-1',
    });
    expect(supabase.updates).toEqual([
      {
        table: 'profiles',
        values: { credits: 110 },
      },
    ]);
    expect(supabase.inserts).toEqual([
      {
        table: 'credit_transactions',
        values: {
          user_id: 'inviter-1',
          amount: 10,
          type: 'addition',
          description: '邀请消费返利（结算 pre-123）：invitee@example.com 消费 200 积分，返利 10 积分',
        },
      },
    ]);
  });

  it('skips when the binding relation is missing or expired', async () => {
    const supabase = createMockSupabase({ invitationRecord: null });

    const result = await applyInvitationRebateForSpend({
      supabase,
      inviteeId: 'invitee-1',
      consumedCredits: 200,
      preDeductId: 'pre-123',
    });

    expect(result).toEqual({
      status: 'no_binding',
      rebateCredits: 0,
    });
    expect(supabase.inserts).toEqual([]);
  });

  it('clips rebate to the remaining daily cap instead of exceeding configured limits', async () => {
    const supabase = createMockSupabase({
      settings: [
        { key: 'invite_rebate_percent', value: 10 },
        { key: 'invite_binding_days', value: 30 },
        { key: 'invite_daily_reward_limit', value: 60 },
        { key: 'invite_total_reward_limit', value: 50000 },
        { key: 'invite_inviter_reward', value: 50 },
        { key: 'invite_invitee_reward', value: 30 },
        { key: 'new_user_credits', value: 100 },
        { key: 'invite_monthly_count_limit', value: 50 },
        { key: 'invite_same_ip_hour_limit', value: 3 },
        { key: 'invite_same_ip_day_limit', value: 5 },
        { key: 'invite_risk_auto_reject', value: true },
      ],
      directTodayRewards: [50],
    });

    const result = await applyInvitationRebateForSpend({
      supabase,
      inviteeId: 'invitee-1',
      consumedCredits: 200,
      preDeductId: 'pre-123',
    });

    expect(result.status).toBe('applied');
    expect(result.rebateCredits).toBe(10);
  });

  it('treats repeated settlement callbacks as already applied and avoids duplicate credits', async () => {
    const supabase = createMockSupabase({
      existingRebate: {
        id: 'txn-1',
        amount: 8,
        description: '邀请消费返利（结算 pre-123）：invitee@example.com 消费 160 积分，返利 8 积分',
      },
    });

    const result = await applyInvitationRebateForSpend({
      supabase,
      inviteeId: 'invitee-1',
      consumedCredits: 160,
      preDeductId: 'pre-123',
    });

    expect(result).toEqual({
      status: 'already_applied',
      rebateCredits: 8,
      inviterId: 'inviter-1',
      invitationRecordId: 'invite-record-1',
    });
    expect(supabase.updates).toEqual([]);
    expect(supabase.inserts).toEqual([]);
  });

  it('sanitizes invitation binding lookup failures', async () => {
    const supabase = createMockSupabase({
      invitationRecordError: { message: 'permission denied for table invitation_records' },
    });

    await expect(
      applyInvitationRebateForSpend({
        supabase,
        inviteeId: 'invitee-1',
        consumedCredits: 160,
        preDeductId: 'pre-123',
      }),
    ).rejects.toThrow('读取邀请绑定关系失败');
  });
});
