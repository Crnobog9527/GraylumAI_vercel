/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClientDeps } from './postForMe/client';
import { cleanupAttempts, runProviderWork, sweepOrphans, type RunReport, type SweepReport } from './providerCleanup';

/**
 * PUBLISH-MONITOR daily job (plan §8, `/api/cron/social-monitor`). PR-2c-2 runs only provider cleanup; data refresh and
 * weekly reviews join this job in PR-3 and PR-6. Cleanup runs even while the feature switch is off: deletions owed to
 * users (disconnect, account erasure) must not wait for the feature to be enabled.
 */
type Db = Pick<SupabaseClient, 'rpc' | 'from'>;
export const ORPHAN_SWEEP_DELETE_SWITCH = 'publish_monitor_orphan_sweep_delete';

export type SocialMonitorReport = {
  providerWork: RunReport | null; attempts: RunReport | null; sweep: SweepReport | null;
  sweepDeleteEnabled: boolean; failures: string[];
};

/** Deleting orphans is opt-in per environment; a missing, unreadable or non-true value means report only. */
async function sweepDeleteEnabled(db: Db): Promise<boolean> {
  const { data, error } = await db.from('system_settings').select('value').eq('key', ORPHAN_SWEEP_DELETE_SWITCH).maybeSingle();
  return !error && data?.value === true;
}

/**
 * Order matters under the time budget: provider deletions owed to users first, then attempts that can no longer be
 * used, then the backstop sweep. A failing step is recorded and the next step still runs.
 */
export async function runSocialMonitorJob(db: Db, client: ClientDeps, until: number,
  now: () => number = Date.now): Promise<SocialMonitorReport> {
  const report: SocialMonitorReport = { providerWork: null, attempts: null, sweep: null, sweepDeleteEnabled: false,
    failures: [] };
  try { report.providerWork = await runProviderWork(db, client, until, now); } catch { report.failures.push('provider_work'); }
  try { report.attempts = await cleanupAttempts(db, client, until, now); } catch { report.failures.push('attempts'); }
  if (now() < until) {
    try {
      report.sweepDeleteEnabled = await sweepDeleteEnabled(db);
      report.sweep = await sweepOrphans(db, client, report.sweepDeleteEnabled, until, now);
    } catch { report.failures.push('sweep'); }
  }
  return report;
}
