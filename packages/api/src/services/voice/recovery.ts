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
 * Fusion call (undispatched released, dispatched at its known cost) and marked failed; receipts of a run whose
 * version was deleted are scrubbed once the run is closed (settling it first when the page never did). Each item is
 * independent; failures are counted and retried. */
export async function recoverVoiceGenerations(admin: SupabaseClient, options: { budget?: RuntimeBudget;
  env?: Record<string, string | undefined> } = {}) {
  const summary = { success: true, settled: 0, scrubbed: 0, waiting: 0, failed: 0 };
  const candidates = await voiceRpc<Candidates>(admin, 'voice_recovery_candidates', { p_limit: 50 });
  const budget = options.budget ?? createRuntimeBudget();
  /** Settles a run like a stopped Fusion call: recorded receipts first, then undispatched released, dispatched at cost. */
  async function settle(actorId: string, runId: string) {
    const window = await loadStagingPolicy(admin as unknown as BillingRpc, actorId, options.env ?? process.env);
    const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor: async () => actorId, budget,
      adapter: stagingTransport(admin, window, budget) });
    await billing.recoverReceipts(runId).catch(() => undefined);
    if (!(await billing.readRun(runId)).closed) await billing.requestCancel(runId);
    return (await billing.finalizeRun(runId)).closed;
  }
  for (const item of candidates.generations) {
    try {
      const settled = item.runId ? await settle(item.actorId, item.runId) : true;
      await voiceRpc(admin, 'voice_generation_finish', { a: item.actorId, vid: item.versionId, result: null,
        failure_code: item.status === 'generating' ? 'VOICE_INTERRUPTED' : null, settled });
      if (settled) summary.settled += 1; else summary.waiting += 1;
    } catch { summary.failed += 1; }
  }
  for (const item of candidates.scrubs) {
    try {
      let outcome = await voiceRpc<string>(admin, 'voice_billing_scrub', { p_run_id: item.runId });
      // The version was deleted while its run was still open: settle the run here, then scrub.
      if (outcome === 'waiting' && await settle(item.actorId, item.runId)) {
        outcome = await voiceRpc<string>(admin, 'voice_billing_scrub', { p_run_id: item.runId });
      }
      if (outcome === 'done') summary.scrubbed += 1; else summary.waiting += 1;
    } catch { summary.failed += 1; }
  }
  summary.success = summary.failed === 0;
  return summary;
}
