/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  applyInvitationRebateForSpend,
  buildInvitationRebateIdempotencyKey,
} from '../invitationRebate';

function defaultSettings() {
  return [
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
}

function createMockSupabase(options?: {
  settings?: Array<{ key: string; value: unknown }>;
  settingsError?: { message: string } | null;
  rpcData?: Array<Record<string, unknown>>;
  rpcError?: { message: string } | null;
}) {
  const fromTables: string[] = [];
  const settings = options?.settings ?? defaultSettings();
  const rpc = vi.fn().mockResolvedValue({
    data: options?.rpcData ?? [
      {
        status: 'applied',
        invitation_record_id: 'invite-record-1',
        inviter_id: 'inviter-1',
        rebate_amount: 10,
        balance_before: 100,
        balance_after: 110,
        transaction_id: 'txn-1',
        idempotency_key: 'invitation_rebate:pre-123',
        is_idempotent: false,
      },
    ],
    error: options?.rpcError ?? null,
  });

  const client = {
    from: vi.fn((table: string) => {
      fromTables.push(table);
      const builder = {
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({
          data: settings,
          error: options?.settingsError ?? null,
        }),
      };

      return builder;
    }),
    rpc,
  };

  return {
    client: client as any,
    fromTables,
    rpc,
  };
}

describe('buildInvitationRebateIdempotencyKey', () => {
  it('uses the stable pre-deduct namespace', () => {
    expect(buildInvitationRebateIdempotencyKey('pre-123')).toBe('invitation_rebate:pre-123');
  });
});

describe('applyInvitationRebateForSpend', () => {
  it('applies rebate through the atomic invitation rebate RPC', async () => {
    const supabase = createMockSupabase();

    const result = await applyInvitationRebateForSpend({
      supabase: supabase.client,
      supabaseAdmin: supabase.client,
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
    expect(supabase.rpc).toHaveBeenCalledWith('atomic_apply_invitation_rebate', {
      p_invitee_id: 'invitee-1',
      p_consumed_credits: 200,
      p_pre_deduct_id: 'pre-123',
      p_rebate_percent: 5,
      p_daily_reward_limit: 1000,
      p_total_reward_limit: 50000,
      p_binding_cutoff: '2026-02-08T12:00:00.000Z',
      p_day_start: '2026-03-09T16:00:00.000Z',
      p_idempotency_key: 'invitation_rebate:pre-123',
    });
    expect(supabase.fromTables).toEqual(['system_settings']);
  });

  it('returns idempotent replay results without relying on description matching', async () => {
    const supabase = createMockSupabase({
      rpcData: [
        {
          status: 'already_applied',
          invitation_record_id: 'invite-record-1',
          inviter_id: 'inviter-1',
          rebate_amount: 8,
          balance_before: 100,
          balance_after: 108,
          transaction_id: 'txn-1',
          idempotency_key: 'invitation_rebate:pre-123',
          is_idempotent: true,
        },
      ],
    });

    const result = await applyInvitationRebateForSpend({
      supabase: supabase.client,
      supabaseAdmin: supabase.client,
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
    expect(supabase.fromTables).not.toContain('credit_transactions');
    expect(supabase.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_idempotency_key: 'invitation_rebate:pre-123',
    });
  });

  it('returns cap_exhausted when the RPC clips the rebate to zero', async () => {
    const supabase = createMockSupabase({
      rpcData: [
        {
          status: 'cap_exhausted',
          invitation_record_id: 'invite-record-1',
          inviter_id: 'inviter-1',
          rebate_amount: 0,
          balance_before: 100,
          balance_after: 100,
          transaction_id: null,
          idempotency_key: 'invitation_rebate:pre-123',
          is_idempotent: false,
        },
      ],
    });

    const result = await applyInvitationRebateForSpend({
      supabase: supabase.client,
      supabaseAdmin: supabase.client,
      inviteeId: 'invitee-1',
      consumedCredits: 200,
      preDeductId: 'pre-123',
    });

    expect(result).toEqual({
      status: 'cap_exhausted',
      rebateCredits: 0,
      inviterId: 'inviter-1',
      invitationRecordId: 'invite-record-1',
    });
  });

  it('skips when the RPC finds no invitation relation', async () => {
    const supabase = createMockSupabase({
      rpcData: [
        {
          status: 'no_binding',
          invitation_record_id: null,
          inviter_id: null,
          rebate_amount: 0,
          transaction_id: null,
          idempotency_key: 'invitation_rebate:pre-123',
          is_idempotent: false,
        },
      ],
    });

    const result = await applyInvitationRebateForSpend({
      supabase: supabase.client,
      supabaseAdmin: supabase.client,
      inviteeId: 'invitee-1',
      consumedCredits: 200,
      preDeductId: 'pre-123',
    });

    expect(result).toEqual({
      status: 'no_binding',
      rebateCredits: 0,
    });
  });

  it('does not call the RPC for zero consumption or disabled rebate settings', async () => {
    const zeroConsumptionSupabase = createMockSupabase();

    await expect(
      applyInvitationRebateForSpend({
        supabase: zeroConsumptionSupabase.client,
        supabaseAdmin: zeroConsumptionSupabase.client,
        inviteeId: 'invitee-1',
        consumedCredits: 0,
        preDeductId: 'pre-123',
      }),
    ).resolves.toEqual({ status: 'zero_consumption', rebateCredits: 0 });
    expect(zeroConsumptionSupabase.rpc).not.toHaveBeenCalled();

    const disabledSupabase = createMockSupabase({
      settings: defaultSettings().map((setting) => (
        setting.key === 'invite_rebate_percent' ? { ...setting, value: 0 } : setting
      )),
    });

    await expect(
      applyInvitationRebateForSpend({
        supabase: disabledSupabase.client,
        supabaseAdmin: disabledSupabase.client,
        inviteeId: 'invitee-1',
        consumedCredits: 200,
        preDeductId: 'pre-123',
      }),
    ).resolves.toEqual({ status: 'disabled', rebateCredits: 0 });
    expect(disabledSupabase.rpc).not.toHaveBeenCalled();
  });

  it('sanitizes RPC failures so partial database failures do not leak details', async () => {
    const supabase = createMockSupabase({
      rpcError: { message: 'forced credit transaction failure' },
    });

    await expect(
      applyInvitationRebateForSpend({
        supabase: supabase.client,
        supabaseAdmin: supabase.client,
        inviteeId: 'invitee-1',
        consumedCredits: 160,
        preDeductId: 'pre-123',
      }),
    ).rejects.toThrow('应用邀请返利失败');
    expect(supabase.fromTables).not.toContain('profiles');
    expect(supabase.fromTables).not.toContain('credit_transactions');
  });
});
