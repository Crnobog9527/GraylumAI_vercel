/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { StagingAccessError } from './stagingErrors';
import { logger } from '../../lib/logger';
import { RateLimitError } from '../../lib/rateLimitError';
import { checkRuntimeRateLimit } from '../redisRateLimiter';
import { readRuntimeRateLimits, type RuntimeRateLimits } from './rateLimitSettings';

export type GateRejection = 'call_limited' | 'paused' | 'limit_unavailable' | 'usage_configuration_required';
export type NewWorkGateResult = { ok: true } | {
  ok: false; reason: GateRejection; retryAfter: number; window?: 'minute' | 'day';
};
export type RuntimeCallGate = (actorId: string, maxCalls: number) => Promise<NewWorkGateResult>;
type SettingsRead = { ok: true; config: RuntimeRateLimits } | { ok: false };
const unavailable = (): NewWorkGateResult => ({ ok: false, reason: 'limit_unavailable', retryAfter: 60 });
export const denyNewCalls: RuntimeCallGate = async () => unavailable();

/** Catch immediately so a replay can ignore this speculative read, including its failure. */
export async function readNewWorkSettings(admin: SupabaseClient): Promise<SettingsRead> {
  try { return { ok: true, config: (await readRuntimeRateLimits(admin)).config }; }
  catch { return { ok: false }; }
}

function pauseResult(settings: SettingsRead, bucket: 'admission' | 'calls' | 'legacy'): NewWorkGateResult {
  if (!settings.ok) return unavailable();
  if (settings.config.stopNewCalls) {
    logger.info('security', 'runtime_new_calls_paused', { bucket });
    return { ok: false, reason: 'paused', retryAfter: 60 };
  }
  return { ok: true };
}

/** Identity must come from the authenticated host, never from the request payload. */
export function newWorkGate(admin: SupabaseClient, environment: 'local' | 'staging') {
  async function check(actorId: string, bucket: 'admission' | 'calls', rate: number, read?: Promise<SettingsRead>) {
    const settings = await (read ?? readNewWorkSettings(admin));
    const pause = pauseResult(settings, bucket);
    if (!pause.ok || !settings.ok) return pause;
    const result = await checkRuntimeRateLimit(actorId, bucket, settings.config, environment, rate);
    if (result.success) return { ok: true } as const;
    return { ok: false, reason: result.reason === 'unavailable' ? 'limit_unavailable'
      : result.reason === 'usage_configuration_required' ? result.reason : 'call_limited',
      retryAfter: result.retryAfter, window: result.window } as const;
  }
  return {
    message: (actorId: string, read?: Promise<SettingsRead>) => check(actorId, 'admission', 1, read),
    calls: ((actorId, maxCalls) => check(actorId, 'calls', maxCalls)) satisfies RuntimeCallGate,
  };
}

export function requireNewWork(result: NewWorkGateResult): void {
  if (result.ok) return;
  if (result.reason === 'usage_configuration_required') throw new StagingAccessError('RUNTIME_USAGE_CONFIGURATION_REQUIRED');
  throw new RateLimitError(result.reason === 'call_limited' ? 'rate_limited' : 'unavailable',
    result.retryAfter, result.reason === 'call_limited' ? result.window ?? 'minute' : result.reason);
}

/** Existing legacy limiters remain unchanged; only the shared pause is added. */
export async function requireLegacyCallsEnabled(admin: SupabaseClient): Promise<void> {
  requireNewWork(pauseResult(await readNewWorkSettings(admin), 'legacy'));
}
