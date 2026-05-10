/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createClient } from '@supabase/supabase-js';
import {
  getBindingCutoffIso,
  getChinaDayStartIso,
  loadInvitationRuntimeSettings,
} from './invitationRuntime';

const INVITATION_REBATE_SOURCE = 'invitation_rebate';
const INVITATION_REBATE_ERRORS = {
  applyRebate: '应用邀请返利失败',
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

interface InvitationRebateRpcRow {
  status?: InvitationRebateResult['status'] | null;
  invitation_record_id?: string | null;
  inviter_id?: string | null;
  rebate_amount?: number | null;
  balance_before?: number | null;
  balance_after?: number | null;
  transaction_id?: string | null;
  idempotency_key?: string | null;
  is_idempotent?: boolean | null;
}

let cachedServiceRoleClient: any = null;

export function buildInvitationRebateIdempotencyKey(preDeductId: string) {
  return `${INVITATION_REBATE_SOURCE}:${preDeductId.trim()}`;
}

function getInvitationRebateRpcClient(fallbackClient: any) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return fallbackClient;
  }

  cachedServiceRoleClient ??= createClient(supabaseUrl, serviceRoleKey);
  return cachedServiceRoleClient;
}

export async function applyInvitationRebateForSpend(args: {
  supabase: any;
  supabaseAdmin?: any;
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
  const idempotencyKey = buildInvitationRebateIdempotencyKey(preDeductId);
  const rpcClient = args.supabaseAdmin ?? getInvitationRebateRpcClient(supabase);

  const { data, error } = await rpcClient.rpc('atomic_apply_invitation_rebate', {
    p_invitee_id: inviteeId,
    p_consumed_credits: consumedCredits,
    p_pre_deduct_id: preDeductId,
    p_rebate_percent: settings.rebatePercent,
    p_daily_reward_limit: settings.dailyRewardLimit,
    p_total_reward_limit: settings.totalRewardLimit,
    p_binding_cutoff: bindingCutoffIso,
    p_day_start: dayStartIso,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    throw new Error(INVITATION_REBATE_ERRORS.applyRebate);
  }

  const rebateResult: InvitationRebateRpcRow | undefined = data?.[0];

  if (!rebateResult?.status) {
    throw new Error(INVITATION_REBATE_ERRORS.applyRebate);
  }

  return {
    status: rebateResult.status,
    rebateCredits: rebateResult.rebate_amount ?? 0,
    inviterId: rebateResult.inviter_id ?? undefined,
    invitationRecordId: rebateResult.invitation_record_id ?? undefined,
  };
}
