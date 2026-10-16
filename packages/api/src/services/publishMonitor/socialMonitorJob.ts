/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClientDeps } from './postForMe/client';
import { PUBLISH_MONITOR_SWITCH } from './foundation';
import { cleanupAttempts, runProviderWork, sweepOrphans, type RunReport, type SweepReport } from './providerCleanup';
import { pruneSnapshots, runRefresh, type RefreshReport, type WindowLookup } from './refresh';

// The cron route reads the owner's data window from the server-side entitlement.
export { entitlementWindow } from './data';

/**
 * PUBLISH-MONITOR daily job (plan §8, `/api/cron/social-monitor`): provider cleanup (PR-2c), snapshot retention and the
 * daily data refresh (PR-3a); weekly reviews join in PR-6. Cleanup and retention run even while the feature switch is
 * off: deletions owed to users (disconnect, account erasure) must not wait for the feature to be enabled. Reading data
 * needs the switch on.
 */
type Db = Pick<SupabaseClient, 'rpc' | 'from'>;
export const ORPHAN_SWEEP_DELETE_SWITCH = 'publish_monitor_orphan_sweep_delete';

export type SocialMonitorReport = {
  providerWork: RunReport | null; attempts: RunReport | null; sweep: SweepReport | null;
  sweepDeleteEnabled: boolean; pruned: number | null; refresh: RefreshReport | null; failures: string[];
};

async function switchOn(db: Db, key: string): Promise<boolean> {
  const { data, error } = await db.from('system_settings').select('value').eq('key', key).maybeSingle();
  return !error && data?.value === true;
}

/** Deleting orphans is opt-in per environment; a missing, unreadable or non-true value means report only. */
const sweepDeleteEnabled = (db: Db) => switchOn(db, ORPHAN_SWEEP_DELETE_SWITCH);

/**
 * Order matters under the time budget: retention (database only), provider deletions owed to users, attempts that can
 * no longer be used, the data refresh, then the backstop sweep (lowest priority, plan §4.1). A failing step is recorded
 * and the next step still runs.
 */
export async function runSocialMonitorJob(db: Db, client: ClientDeps, until: number, windowFor: WindowLookup,
  now: () => number = Date.now): Promise<SocialMonitorReport> {
  const report: SocialMonitorReport = { providerWork: null, attempts: null, sweep: null, sweepDeleteEnabled: false,
    pruned: null, refresh: null, failures: [] };
  try { report.pruned = await pruneSnapshots(db); } catch { report.failures.push('prune'); }
  try { report.providerWork = await runProviderWork(db, client, until, now); } catch { report.failures.push('provider_work'); }
  try { report.attempts = await cleanupAttempts(db, client, until, now); } catch { report.failures.push('attempts'); }
  if (now() < until) {
    try {
      if (await switchOn(db, PUBLISH_MONITOR_SWITCH)) report.refresh = await runRefresh(db, client, windowFor, until, now);
    } catch { report.failures.push('refresh'); }
  }
  if (now() < until) {
    try {
      report.sweepDeleteEnabled = await sweepDeleteEnabled(db);
      report.sweep = await sweepOrphans(db, client, report.sweepDeleteEnabled, until, now);
    } catch { report.failures.push('sweep'); }
  }
  return report;
}
