/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import {
  getBindingCutoffIso,
  getChinaDayStartIso,
  loadInvitationRuntimeSettings,
} from './invitationRuntime';

const INVITATION_REBATE_PREFIX = '邀请消费返利（结算 ';
const INVITATION_REBATE_ERRORS = {
  loadBinding: '读取邀请绑定关系失败',
  loadStatus: '读取邀请返利状态失败',
  loadInviterProfile: '读取邀请人资料失败',
  updateInviterCredits: '更新邀请人积分失败',
  createTransaction: '写入邀请返利记录失败',
} as const;

export interface InvitationRebateResult {
  status:
    | 'applied'
    | 'already_applied'
    | 'no_binding'
    | 'disabled'
    | 'zero_consumption'
    | 'below_minimum'
    | 'cap_exhausted';
  rebateCredits: number;
  inviterId?: string;
  invitationRecordId?: string;
}

function sumAmounts(rows: Array<{ amount?: number | null; inviter_reward?: number | null }> | null | undefined) {
  return (rows ?? []).reduce((sum, row) => {
    if (typeof row.amount === 'number') {
      return sum + row.amount;
    }
    if (typeof row.inviter_reward === 'number') {
      return sum + row.inviter_reward;
    }
    return sum;
  }, 0);
}

function buildRebateDescription(preDeductId: string, inviteeEmail: string, consumedCredits: number, rebateCredits: number) {
  return `${INVITATION_REBATE_PREFIX}${preDeductId}）：${inviteeEmail} 消费 ${consumedCredits} 积分，返利 ${rebateCredits} 积分`;
}

export async function applyInvitationRebateForSpend(args: {
  supabase: any;
  inviteeId: string;
  consumedCredits: number;
  preDeductId: string;
  now?: Date;
}): Promise<InvitationRebateResult> {
  const { supabase, inviteeId, consumedCredits, preDeductId } = args;
  const now = args.now ?? new Date();

  if (consumedCredits <= 0) {
    return { status: 'zero_consumption', rebateCredits: 0 };
  }

  const settings = await loadInvitationRuntimeSettings(supabase);

  if (settings.rebatePercent <= 0 || settings.bindingDays <= 0) {
    return { status: 'disabled', rebateCredits: 0 };
  }

  const bindingCutoffIso = getBindingCutoffIso(settings.bindingDays, now);
  const dayStartIso = getChinaDayStartIso(now);

  const { data: invitationRecord, error: invitationRecordError } = await supabase
    .from('invitation_records')
    .select('id, inviter_id, invitee_email, created_at')
    .eq('invitee_id', inviteeId)
    .eq('status', 'rewarded')
    .gte('created_at', bindingCutoffIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (invitationRecordError) {
    throw new Error(INVITATION_REBATE_ERRORS.loadBinding);
  }

  if (!invitationRecord?.inviter_id) {
    return { status: 'no_binding', rebateCredits: 0 };
  }

  const rawRebateCredits = Math.floor((consumedCredits * settings.rebatePercent) / 100);

  if (rawRebateCredits <= 0) {
    return {
      status: 'below_minimum',
      rebateCredits: 0,
      inviterId: invitationRecord.inviter_id,
      invitationRecordId: invitationRecord.id,
    };
  }

  const duplicatePattern = `%结算 ${preDeductId}%`;
  const [existingRebateResult, directTodayResult, directTotalResult, rebateTodayResult, rebateTotalResult] = await Promise.all([
    supabase
      .from('credit_transactions')
      .select('id, amount, description')
      .eq('user_id', invitationRecord.inviter_id)
      .eq('type', 'addition')
      .ilike('description', duplicatePattern)
      .maybeSingle(),
    supabase
      .from('invitation_records')
      .select('inviter_reward')
      .eq('inviter_id', invitationRecord.inviter_id)
      .eq('status', 'rewarded')
      .gte('created_at', dayStartIso),
    supabase
      .from('invitation_records')
      .select('inviter_reward')
      .eq('inviter_id', invitationRecord.inviter_id)
      .eq('status', 'rewarded'),
    supabase
      .from('credit_transactions')
      .select('amount')
      .eq('user_id', invitationRecord.inviter_id)
      .eq('type', 'addition')
      .ilike('description', `${INVITATION_REBATE_PREFIX}%`)
      .gte('created_at', dayStartIso),
    supabase
      .from('credit_transactions')
      .select('amount')
      .eq('user_id', invitationRecord.inviter_id)
      .eq('type', 'addition')
      .ilike('description', `${INVITATION_REBATE_PREFIX}%`),
  ]);

  const queryErrors = [
    existingRebateResult.error,
    directTodayResult.error,
    directTotalResult.error,
    rebateTodayResult.error,
    rebateTotalResult.error,
  ].filter(Boolean);

  if (queryErrors.length > 0) {
    throw new Error(INVITATION_REBATE_ERRORS.loadStatus);
  }

  if (existingRebateResult.data) {
    return {
      status: 'already_applied',
      rebateCredits: existingRebateResult.data.amount ?? 0,
      inviterId: invitationRecord.inviter_id,
      invitationRecordId: invitationRecord.id,
    };
  }

  const inviterRewardedToday = sumAmounts(directTodayResult.data) + sumAmounts(rebateTodayResult.data);
  const inviterRewardedTotal = sumAmounts(directTotalResult.data) + sumAmounts(rebateTotalResult.data);

  let grantedRebateCredits = rawRebateCredits;

  if (settings.dailyRewardLimit > 0) {
    grantedRebateCredits = Math.min(
      grantedRebateCredits,
      Math.max(0, settings.dailyRewardLimit - inviterRewardedToday)
    );
  }

  if (settings.totalRewardLimit > 0) {
    grantedRebateCredits = Math.min(
      grantedRebateCredits,
      Math.max(0, settings.totalRewardLimit - inviterRewardedTotal)
    );
  }

  if (grantedRebateCredits <= 0) {
    return {
      status: 'cap_exhausted',
      rebateCredits: 0,
      inviterId: invitationRecord.inviter_id,
      invitationRecordId: invitationRecord.id,
    };
  }

  const { data: inviterProfile, error: inviterProfileError } = await supabase
    .from('profiles')
    .select('credits')
    .eq('id', invitationRecord.inviter_id)
    .single();

  if (inviterProfileError || !inviterProfile) {
    throw new Error(INVITATION_REBATE_ERRORS.loadInviterProfile);
  }

  const { error: updateInviterError } = await supabase
    .from('profiles')
    .update({
      credits: Math.max(0, (inviterProfile.credits ?? 0) + grantedRebateCredits),
    })
    .eq('id', invitationRecord.inviter_id);

  if (updateInviterError) {
    throw new Error(INVITATION_REBATE_ERRORS.updateInviterCredits);
  }

  const description = buildRebateDescription(
    preDeductId,
    invitationRecord.invitee_email ?? inviteeId,
    consumedCredits,
    grantedRebateCredits
  );

  const { error: insertError } = await supabase
    .from('credit_transactions')
    .insert({
      user_id: invitationRecord.inviter_id,
      amount: grantedRebateCredits,
      type: 'addition',
      description,
    });

  if (insertError) {
    throw new Error(INVITATION_REBATE_ERRORS.createTransaction);
  }

  return {
    status: 'applied',
    rebateCredits: grantedRebateCredits,
    inviterId: invitationRecord.inviter_id,
    invitationRecordId: invitationRecord.id,
  };
}
