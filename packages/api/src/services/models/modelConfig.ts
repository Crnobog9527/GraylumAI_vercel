/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';

/** Keys of `ai_models.config` that only their own procedures write:
 * `reasoning` (MODEL-REASONING settings) and `pricing` (the OpenRouter price
 * snapshot, MODEL-PRICING-SYNC). */
export const MANAGED_CONFIG_KEYS = ['reasoning', 'pricing'] as const;

/** `ai_models.config` also holds connection-test state. Every generic config
 * writer drops managed keys sent by the client and keeps the stored ones, so
 * it can neither drop nor forge reasoning settings or prices. */
export function withStoredManagedKeys(next: Record<string, unknown>, current: unknown): Record<string, unknown> {
  const stored = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
  const result = Object.fromEntries(Object.entries(next).filter(([key]) => !(MANAGED_CONFIG_KEYS as readonly string[]).includes(key)));
  for (const key of MANAGED_CONFIG_KEYS) if (stored[key] !== undefined) result[key] = stored[key];
  return result;
}

/** Writes only the connection-test keys onto the latest stored config. A slow
 * provider check never writes back the config it read before the check, so it
 * cannot roll back a price snapshot or reasoning settings saved meanwhile.
 * One retry on a concurrent change; after that this best-effort status is
 * skipped and logged. */
export async function mergeConnectionState(db: SupabaseClient, modelId: string, patch: Record<string, unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await db.from('ai_models').select('config, updated_at').eq('id', modelId).maybeSingle();
    if (error || !data) return false;
    const current = data.config && typeof data.config === 'object' && !Array.isArray(data.config) ? data.config as Record<string, unknown> : {};
    const { data: saved, error: writeError } = await db.from('ai_models')
      .update({ config: { ...current, ...patch }, updated_at: new Date().toISOString() })
      .eq('id', modelId).eq('updated_at', data.updated_at).select('id');
    if (writeError) return false;
    if (Array.isArray(saved) && saved.length === 1) return true;
  }
  logger.warn('api', 'model_connection_state_skipped', { modelId, reason: 'concurrent_update' });
  return false;
}
