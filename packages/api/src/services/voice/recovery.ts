/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { voiceRpc } from './state';
import { logSwallowed, swallow } from '../../lib/swallow';

type Candidates = {
  generations: Array<{ actorId: string; versionId: string; runId: string | null; status: string; hasProfile: boolean }>;
};

/** Daily backstop (billing-reconcile): a generation whose page closed before it finished, or whose server stopped, is recorded as
 * interrupted so the user can start again. The money is not settled here: the turn of the generation (kind=voice) is closed and
 * settled by the turn recovery (runtime-recovery: a crash, 15 minutes; a pending cost, the settlement pass), and a turn that did not
 * save a profile pays nothing. A version made on the retired BILL2 path (it carries a billing run) is left alone: its run is not
 * settled by this job any more (V2-12 B7; none was open when this was written). Whatever does not fit is left for the next run. */
export async function recoverVoiceGenerations(admin: SupabaseClient, options: { now?: () => number; timeLimitMs?: number } = {}) {
  const summary = { success: true, settled: 0, scrubbed: 0, waiting: 0, deferred: 0, failed: 0 };
  const now = options.now ?? Date.now;
  // The cron route has 60 seconds in total and runs other reconciliations alongside.
  const stopAt = now() + (options.timeLimitMs ?? 40_000);
  const candidates = await voiceRpc<Candidates>(admin, 'voice_recovery_candidates', { p_limit: 50 });
  for (const item of candidates.generations) {
    if (now() + 5_000 > stopAt) { summary.deferred += 1; continue; }
    if (item.runId) { summary.waiting += 1; continue; }
    try {
      await voiceRpc(admin, 'voice_generation_finish', { a: item.actorId, vid: item.versionId, result: null,
        failure_code: item.status === 'generating' ? 'VOICE_INTERRUPTED' : null, settled: true });
      summary.settled += 1;
    } catch (error) {
      summary.failed += 1;
      logSwallowed('voice_generation_recovery_failed', error, { category: 'billing' });
      await swallow('voice_recovery_touch_failed', voiceRpc(admin, 'voice_recovery_touch', { p_version_id: item.versionId }), undefined);
    }
  }
  summary.success = summary.failed === 0;
  return summary;
}
