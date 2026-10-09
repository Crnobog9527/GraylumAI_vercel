/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';

export const STOP_LOSS_KEY = 'runtime_stop_loss';
export const usdThreshold = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,12})?$/).nullable();
export const stopLossConfigSchema = z.object({
  version: z.literal(1),
  userDailyUsd: usdThreshold,
  siteDailyUsd: usdThreshold,
  siteAlertUsd: usdThreshold,
  providerBalanceAlertUsd: usdThreshold,
  notificationChannel: z.string().trim().min(1).refine(value => [...value].length <= 100, 'Maximum 100 Unicode characters').nullable(),
}).strict();
export type StopLossConfig = z.infer<typeof stopLossConfigSchema>;
export const DEFAULT_STOP_LOSS: StopLossConfig = {
  version: 1, userDailyUsd: null, siteDailyUsd: null, siteAlertUsd: null,
  providerBalanceAlertUsd: null, notificationChannel: null,
};
function unavailable(): never {
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'RUNTIME_STOP_LOSS_UNAVAILABLE' });
}
export async function readStopLoss(db: SupabaseClient) {
  try {
    const { data, error } = await db.from('system_settings').select('value').eq('key', STOP_LOSS_KEY).maybeSingle();
    if (error) return unavailable();
    const config = data ? stopLossConfigSchema.parse(typeof data.value === 'string' ? JSON.parse(data.value) : data.value)
      : { ...DEFAULT_STOP_LOSS };
    return { config, source: data ? 'configured' as const : 'default' as const };
  } catch { return unavailable(); }
}
export async function saveStopLoss(db: SupabaseClient, input: StopLossConfig) {
  const config = stopLossConfigSchema.parse(input);
  try {
    const { error } = await db.from('system_settings').upsert({ key: STOP_LOSS_KEY, value: config }, { onConflict: 'key' });
    if (error) return unavailable();
    return await readStopLoss(db);
  } catch { return unavailable(); }
}
export async function stopLossStatus(db: SupabaseClient) {
  try {
    const settings = await readStopLoss(db);
    const { data, error } = await db.rpc('runtime_stop_loss_usage', { a: null });
    if (error || !data) return unavailable();
    return { ...settings, usage: data, basis: 'settled_provider_usd', timezone: 'UTC', externalNotifications: 'not_connected' };
  } catch { return unavailable(); }
}
export async function stopLossAlerts(db: SupabaseClient) {
  try {
    const { data, error } = await db.from('diagnostic_results')
      .select('id,test_id,status,details,created_at').like('test_id', 'runtime_stop_loss_%')
      .order('created_at', { ascending: false }).limit(100);
    if (error) return unavailable();
    return { alerts: data ?? [], limit: 100 };
  } catch { return unavailable(); }
}
