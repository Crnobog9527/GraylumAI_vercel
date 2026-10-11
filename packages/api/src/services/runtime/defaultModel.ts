/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPaygHostPolicies } from './paygHostPolicy';
import { admitReasoning } from './reasoningAdmission';
import { FREE_CHAT_REQUEST_FORMAT } from './providerRequest';
import { StagingAccessError } from './stagingErrors';
import type { StagingPolicy } from './stagingPolicy';

/**
 * Free chat uses the first offered model by default, so the administrator's default
 * (`primary_model_id`) is moved to the front. Order is presentation only: admission
 * still decides every request, so an unreadable or unknown setting keeps the original order.
 */
export async function defaultModelFirst<T extends { id: string }>(admin: SupabaseClient, models: readonly T[]): Promise<T[]> {
  const setting = await admin.from('system_settings').select('value').eq('key', 'primary_model_id').maybeSingle();
  const primaryId = !setting.error && typeof setting.data?.value === 'string' ? setting.data.value : undefined;
  return [...models].sort((a, b) => Number(b.id === primaryId) - Number(a.id === primaryId));
}

type ModelRow = { id: string; name: string; model_id: string; config?: unknown };

/**
 * Staging free chat offers only models a new free-chat turn can be admitted with: the same
 * interactive reasoning and per-call billing profile checks admission runs (ordinary purpose,
 * free-chat request format). Admission still rechecks every request; this only hides models
 * that are certain to be refused (e.g. one without a billing profile). With per-call billing
 * off or its setting unreadable nothing is hidden, and admission reports the real reason.
 */
export async function freeChatModels(admin: SupabaseClient, window: StagingPolicy, rows: readonly ModelRow[],
  env: Record<string, string | undefined> = process.env): Promise<Array<{ id: string; name: string }>> {
  const offered: Array<{ id: string; name: string }> = [];
  for (const row of rows) {
    const policy = window.callPolicies.find(p => p.modelId === row.id && p.model === row.model_id);
    if (!policy?.providerLimits) continue;
    try {
      const reasoning = admitReasoning(row, 'interactive', policy.providerLimits.providerSlug, policy.outputLimit);
      const admitted = await readPaygHostPolicies(admin, window, [policy],
        [{ modelId: row.id, phase: 'ordinary', outputLimit: 1, requestFormat: FREE_CHAT_REQUEST_FORMAT, reasoning }], env);
      if (!admitted) return rows.map(({ id, name }) => ({ id, name }));
    } catch (cause) {
      if (cause instanceof StagingAccessError && cause.reason === 'RUNTIME_PAYG_CONFIG_UNAVAILABLE')
        return rows.map(({ id, name }) => ({ id, name }));
      continue;
    }
    offered.push({ id: row.id, name: row.name });
  }
  return offered;
}
