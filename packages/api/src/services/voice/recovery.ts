/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { authoritativeBilling, type BillingRpc } from '../bill2/service';
import { createRuntimeBudget, type RuntimeBudget } from '../runtime/budget';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { stagingTransport } from '../runtime/stagingTransport';
import { voiceRpc } from './state';

type Candidates = { generations: Array<{ actorId: string; versionId: string; runId: string | null; status: string }>;
  scrubs: Array<{ actorId: string; runId: string }> };

/** Daily backstop (billing-reconcile): a generation whose page closed before it finished is settled like a stopped
 * Fusion call (undispatched released, dispatched at its known cost) and marked failed; receipts of a run whose source
 * document was deleted are scrubbed once the run is closed. Each item is independent; failures are counted and retried. */
export async function recoverVoiceGenerations(admin: SupabaseClient, options: { budget?: RuntimeBudget;
  env?: Record<string, string | undefined> } = {}) {
  const summary = { success: true, settled: 0, scrubbed: 0, waiting: 0, failed: 0 };
  const candidates = await voiceRpc<Candidates>(admin, 'voice_recovery_candidates', { p_limit: 50 });
  const budget = options.budget ?? createRuntimeBudget();
  for (const item of candidates.generations) {
    try {
      let settled = true;
      if (item.runId) {
        const window = await loadStagingPolicy(admin as unknown as BillingRpc, item.actorId, options.env ?? process.env);
        const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor: async () => item.actorId, budget,
          adapter: stagingTransport(admin, window, budget) });
        await billing.recoverReceipts(item.runId).catch(() => undefined);
        const state = await billing.readRun(item.runId);
        if (!state.closed) await billing.requestCancel(item.runId);
        settled = (await billing.finalizeRun(item.runId)).closed;
      }
      await voiceRpc(admin, 'voice_generation_finish', { a: item.actorId, vid: item.versionId, result: null,
        failure_code: item.status === 'generating' ? 'VOICE_INTERRUPTED' : null, settled });
      if (settled) summary.settled += 1; else summary.waiting += 1;
    } catch { summary.failed += 1; }
  }
  for (const item of candidates.scrubs) {
    try {
      const outcome = await voiceRpc<string>(admin, 'voice_billing_scrub', { p_run_id: item.runId });
      if (outcome === 'done') summary.scrubbed += 1; else summary.waiting += 1;
    } catch { summary.failed += 1; }
  }
  summary.success = summary.failed === 0;
  return summary;
}
