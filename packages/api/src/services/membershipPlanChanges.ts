/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSafeServiceUnavailableError } from '../lib/publicError';
import type { EntitlementPatch, MembershipLevel } from './membershipEntitlementConfig';

export async function assertExplicitEntitlementsOnLevelChange(
  client: SupabaseClient,
  input: EntitlementPatch & { id: string; level?: MembershipLevel },
) {
  if (input.level === undefined) return;
  const { data, error } = await client.from('membership_plans').select('level').eq('id', input.id).single();
  if (error || !data) throw createSafeServiceUnavailableError(error, '无法核对会员等级，请刷新后重试');
  if (data.level !== input.level && (
    input.allowFusionReview === undefined || input.allowFusionCompare === undefined || input.libraryStorageBytes === undefined
  )) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '改变计划等级时必须明确填写全部会员权益' });
  }
  return data.level as MembershipLevel;
}
