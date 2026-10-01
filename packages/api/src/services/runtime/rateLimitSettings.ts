/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { logger } from '../../lib/logger';

export const RUNTIME_RATE_LIMIT_KEY = 'runtime_rate_limits';
export const runtimeRateLimitsSchema = z.object({
  version: z.literal(1),
  admissionPerMinute: z.number().int().min(1).max(60),
  admissionPer24Hours: z.number().int().min(1).max(5000),
  callsPerMinute: z.number().int().min(1).max(180),
  callsPer24Hours: z.number().int().min(1).max(15000),
  stopNewCalls: z.boolean(),
}).strict().refine(v => v.admissionPer24Hours >= v.admissionPerMinute
  && v.callsPer24Hours >= v.callsPerMinute, '日限额不能低于分钟限额');
export type RuntimeRateLimits = z.infer<typeof runtimeRateLimitsSchema>;
export const DEFAULT_RUNTIME_RATE_LIMITS: RuntimeRateLimits = {
  version: 1, admissionPerMinute: 10, admissionPer24Hours: 200,
  callsPerMinute: 30, callsPer24Hours: 600, stopNewCalls: false,
};

function unavailable(reason: 'read_failed' | 'invalid' | 'write_failed'): never {
  logger.error('security', 'runtime_rate_limit_config_unavailable', { reason });
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '无法读取或保存使用额度，请稍后再试' });
}

/** No cross-request cache: a failed read must never become the default configuration. */
export async function readRuntimeRateLimits(db: SupabaseClient) {
  let result;
  try {
    result = await db.from('system_settings').select('value')
      .eq('key', RUNTIME_RATE_LIMIT_KEY).maybeSingle();
  } catch { return unavailable('read_failed'); }
  if (result.error) return unavailable('read_failed');
  if (!result.data) return { config: { ...DEFAULT_RUNTIME_RATE_LIMITS }, source: 'default' as const };
  try {
    const raw = result.data.value;
    const config = runtimeRateLimitsSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    return { config, source: 'configured' as const };
  } catch { return unavailable('invalid'); }
}

export async function saveRuntimeRateLimits(db: SupabaseClient, input: RuntimeRateLimits) {
  const config = runtimeRateLimitsSchema.parse(input);
  let result;
  try {
    result = await db.from('system_settings').upsert({
      key: RUNTIME_RATE_LIMIT_KEY, value: JSON.stringify(config),
    }, { onConflict: 'key' });
  } catch { return unavailable('write_failed'); }
  if (result.error) return unavailable('write_failed');
  return readRuntimeRateLimits(db);
}
