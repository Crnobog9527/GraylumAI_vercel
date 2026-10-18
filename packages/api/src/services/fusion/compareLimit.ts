/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSafeServiceUnavailableError } from '../../lib/publicError';
import { FUSION_COMPARE_SETTING } from '../membershipEntitlementConfig';
import { readCompareFloor } from './settings';

/** D3 (fusion_compare_max_models) may not fall below what the compare settings already require: the minimum number of
 * models per compare (2 <= min <= D3, Owner 2026-10-03) and the default tick count. Checked against the stored settings. */
export async function validateCompareLimit(client: SupabaseClient, input: Array<{key:string;value:unknown}>) {
  const limit = input.find(item => item.key === FUSION_COMPARE_SETTING)?.value;
  if (typeof limit !== 'number') return;
  let floor;
  try { floor = await readCompareFloor(client); }
  catch (error) { throw createSafeServiceUnavailableError(error, '暂时无法验证 Fusion 对比设置，请稍后重试'); }
  if (limit < floor.minModels || limit < floor.defaultCount) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '对比模型上限不能低于“每次对比最少勾选数”和默认勾选的模型数，请先修改 Fusion 对比设置' });
  }
}
