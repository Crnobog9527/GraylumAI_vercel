/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSafeServiceUnavailableError } from '../../lib/publicError';

export const PAYMENT_CHANNEL_KEY = 'payment_new_purchase_channel';
export const paymentChannelSettingSchema = z.object({
  channel: z.enum(['waffo', 'stripe']),
  version: z.number().int().min(1).max(9999999999),
}).strict();

export async function readPaymentChannel(db: Pick<SupabaseClient, 'from'>) {
  const result = await db.from('system_settings').select('value').eq('key', PAYMENT_CHANNEL_KEY).maybeSingle()
    .then(result => result, error => {
      throw createSafeServiceUnavailableError(error, '支付渠道暂时无法读取，请稍后重试');
    });
  if (result.error) throw createSafeServiceUnavailableError(result.error, '支付渠道暂时无法读取，请稍后重试');
  if (!result.data) return { channel: 'waffo' as const, version: 0 };
  const parsed = paymentChannelSettingSchema.safeParse(result.data.value);
  if (!parsed.success) throw createSafeServiceUnavailableError(parsed.error, '支付渠道配置无效，请联系管理员');
  return parsed.data;
}

// Preflight before any provider call. The SQL transaction remains authoritative against saves racing this read.
export async function assertCheckoutChannel(db: Pick<SupabaseClient, 'from'>, userId: string, itemType: string) {
  const pending = await db.from('payment_orders').select('payment_channel')
    .eq('user_id', userId).eq('item_type', itemType).eq('purchase_action', 'checkout')
    .is('purchase_closed_at', null).is('fulfilled_at', null).order('created_at').limit(1).maybeSingle()
    .then(result => result, error => {
      throw createSafeServiceUnavailableError(error, '支付订单暂时无法读取，请稍后重试');
    });
  if (pending.error) throw createSafeServiceUnavailableError(pending.error, '支付订单暂时无法读取，请稍后重试');
  const channel = pending.data ? pending.data.payment_channel : (await readPaymentChannel(db)).channel;
  if (channel !== 'stripe') throw createSafeServiceUnavailableError(
    new Error('PAY_COMMON_CHANNEL_NOT_READY'), '当前支付渠道尚未接入，暂不可购买');
}
