/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { authoritativeBilling, type BillingRpc, type BillingTransport } from '../bill2/service';
import { createRuntimeBudget } from '../runtime/budget';
import { parseStagingPolicy } from '../runtime/stagingPolicy';
import { stagingTransport } from '../runtime/stagingTransport';
import { isSettled, voiceEvidence } from './generation';
import { voiceRpc } from './state';

type Item = { actorId: string; runId: string | null; recovery: unknown };
type Candidates = {
  generations: Array<Item & { versionId: string; status: string; hasProfile: boolean }>;
  scrubs: Array<Item & { runId: string; outcome: 'cancelled' | 'confirmed_failure' }>;
};
const noTransport: BillingTransport = {
  dispatch: async () => { throw new Error('VOICE_RECOVERY_NO_DISPATCH'); },
  lookup: async () => { throw new Error('VOICE_RECOVERY_LOOKUP_UNAVAILABLE'); },
};

/** Daily backstop (billing-reconcile): a generation whose page closed before it finished is settled like a stopped
 * Fusion call (undispatched released, dispatched at its known cost) and marked failed; receipts of a run whose
 * version was deleted are scrubbed once the run is closed (settling it first when the page never did). As in Fusion
 * recovery, each run is settled with its own frozen binding (never live admission, which a closed window or a disabled
 * model would refuse forever), within the cron's time limit; whatever does not fit is left for the next run. */
export async function recoverVoiceGenerations(admin: SupabaseClient, options: { now?: () => number; timeLimitMs?: number } = {}) {
  const summary = { success: true, settled: 0, scrubbed: 0, waiting: 0, deferred: 0, failed: 0 };
  const now = options.now ?? Date.now;
  // The cron route has 60 seconds in total and runs other reconciliations alongside.
  const stopAt = now() + (options.timeLimitMs ?? 40_000);
  const candidates = await voiceRpc<Candidates>(admin, 'voice_recovery_candidates', { p_limit: 50 });
  /** `outcome`: a profile was saved (delivered), none was (confirmed failure: provider cost recorded, user refunded), or the
   * user deleted the version (cancelled: undispatched released, dispatched at its known cost). */
  async function settle(item: Item & { runId: string }, outcome: 'delivered' | 'confirmed_failure' | 'cancelled', evidenceId?: string) {
    const budget = createRuntimeBudget(now, Math.max(1, stopAt - now()));
    const adapter = item.recovery ? stagingTransport(admin, parseStagingPolicy(item.recovery), budget) : noTransport;
    const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor: async () => item.actorId, adapter, budget });
    if (item.recovery) await billing.recoverReceipts(item.runId, { timeoutMs: 2000 }).catch(() => undefined);
    if (!(await billing.readRun(item.runId)).closed) {
      if (outcome === 'cancelled' || !evidenceId) await billing.requestCancel(item.runId);
      else await billing.closeRun(item.runId, outcome,
        voiceEvidence(evidenceId, outcome === 'delivered' ? 'ok' : 'failed'));
    }
    return isSettled(await billing.finalizeRun(item.runId));
  }
  // Keep room for the slowest single step (one lookup and settlement) before the limit.
  const outOfTime = () => now() + 10_000 > stopAt;
  const doGeneration = async (item: Candidates['generations'][number]) => {
    if (outOfTime()) { summary.deferred += 1; return; }
    try {
      // Delivered only when a profile was really saved. A version marked failed (result pending) or still generating has
      // none: the user must not be charged for a result they never received.
      const settled = item.runId ? await settle({ ...item, runId: item.runId },
        item.hasProfile ? 'delivered' : 'confirmed_failure', item.versionId) : true;
      await voiceRpc(admin, 'voice_generation_finish', { a: item.actorId, vid: item.versionId, result: null,
        failure_code: item.status === 'generating' ? 'VOICE_INTERRUPTED' : null, settled });
      if (settled) summary.settled += 1; else summary.waiting += 1;
    } catch {
      summary.failed += 1;
      await voiceRpc(admin, 'voice_recovery_touch', { p_version_id: item.versionId }).catch(() => undefined);
    }
  };
  const doScrub = async (item: Candidates['scrubs'][number]) => {
    if (outOfTime()) { summary.deferred += 1; return; }
    try {
      let outcome = await voiceRpc<string>(admin, 'voice_billing_scrub', { p_run_id: item.runId });
      // The version was deleted while its run was still open: settle the run here, then scrub.
      if (outcome === 'waiting' && await settle(item, item.outcome, item.runId)) {
        outcome = await voiceRpc<string>(admin, 'voice_billing_scrub', { p_run_id: item.runId });
      }
      if (outcome === 'done') summary.scrubbed += 1; else summary.waiting += 1;
    } catch {
      summary.failed += 1;
      await voiceRpc(admin, 'voice_scrub_touch', { p_run_id: item.runId }).catch(() => undefined);
    }
  };
  // Alternate the two queues, so a full generation queue can never starve the deleted-content scrubs (or the reverse).
  const total = Math.max(candidates.generations.length, candidates.scrubs.length);
  for (let index = 0; index < total; index++) {
    if (candidates.generations[index]) await doGeneration(candidates.generations[index]!);
    if (candidates.scrubs[index]) await doScrub(candidates.scrubs[index]!);
  }
  summary.success = summary.failed === 0;
  return summary;
}
