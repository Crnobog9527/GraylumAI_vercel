/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClientDeps } from './postForMe/client';
import { reconcilePublishes, type ReconcileReport } from './publish';
import { PUBLISH_MONITOR_SWITCH } from './foundation';
import { cleanupAttempts, runProviderWork, sweepOrphans, type RunReport, type SweepReport } from './providerCleanup';
import { pruneSnapshots, runRefresh, type RefreshReport, type WindowLookup } from './refresh';
import { closeOrphanRuns, runTikhubRefresh, type TikhubEntitlementLookup, type TikhubReport } from './tikhubRefresh';

// The cron route reads the owner's data window from the server-side entitlement.
export { entitlementWindow } from './data';
export { tikhubEntitlements } from './tikhubRefresh';

/** PR-4b: the billed TikHub step (own Xiaohongshu/Douyin accounts and Gold benchmarks); absent = not run. */
export type TikhubStep = { env: Record<string, string | undefined>; entitlement: TikhubEntitlementLookup };

/**
 * PUBLISH-MONITOR daily job (plan §8, `/api/cron/social-monitor`): provider cleanup (PR-2c), snapshot retention and the
 * daily data refresh (PR-3a), and reconciliation of open publishes (PR-5); weekly reviews join in PR-6. Cleanup,
 * retention and publish reconciliation run even while the feature switch is off: deletions owed to users (disconnect,
 * account erasure) and publishes holding their credits must not wait for the feature to be enabled. Reading data needs
 * the switch on.
 */
type Db = Pick<SupabaseClient, 'rpc' | 'from'>;
export const ORPHAN_SWEEP_DELETE_SWITCH = 'publish_monitor_orphan_sweep_delete';

export type SocialMonitorReport = {
  publishes: ReconcileReport | null; providerWork: RunReport | null; attempts: RunReport | null; sweep: SweepReport | null;
  sweepDeleteEnabled: boolean; pruned: number | null; refresh: RefreshReport | null; tikhub: TikhubReport | null;
  billedRunsClosed: number | null; billedPruned: number | null; postForMe: boolean; failures: string[];
};

/** Strictly true or off; a setting that cannot be read is reported as a failure, never as "off". */
async function switchOn(db: Db, key: string): Promise<boolean> {
  const { data, error } = await db.from('system_settings').select('value').eq('key', key).maybeSingle();
  if (error) throw new Error('SETTING_UNAVAILABLE');
  return data?.value === true;
}

// Deleting orphans stays opt-in: an unreadable setting means report only, as before.
const sweepDeleteEnabled = (db: Db) => switchOn(db, ORPHAN_SWEEP_DELETE_SWITCH).catch(() => false);

/**
 * For an environment without a Post for Me key, database-only work: snapshots already stored must still expire after
 * 100 days (plan §7), and expired publish claims are released (plan §6). No provider call.
 */
export async function runSocialMonitorRetention(db: Db, until: number, now: () => number = Date.now) {
  const pruned = await pruneSnapshots(db, until, now);
  // Expired publish claims hold users' credits and slots; releasing them needs no provider either (plan §6).
  const publishes = await reconcilePublishes(db, null, until, now);
  return { pruned, publishes };
}

async function pruneBilledReads(db: Db): Promise<number> {
  const result = await db.rpc('publish_monitor_billed_prune', { p_limit: 20_000 });
  if (result.error || typeof result.data !== 'number') throw new Error('PUBLISH_MONITOR_BILLED_PRUNE_FAILED');
  return result.data;
}

/**
 * Order matters under the time budget: retention (database only), open publishes (they hold users' credits and slots,
 * and a deletion waits for them), billed TikHub runs a killed process left open (they hold users' credits), provider
 * deletions owed to users, attempts that can no longer be used, the data refreshes, then the backstop sweep (lowest
 * priority, plan §4.1). A failing step is recorded and the next step still runs. Without a Post for Me key (`client`
 * null) the Post for Me steps are skipped; retention, held credits and the TikHub reads still run. Settling held
 * credits never waits for the feature switch; reading data needs it on.
 */
export async function runSocialMonitorJob(db: Db, client: ClientDeps | null, until: number, windowFor: WindowLookup,
  now: () => number = Date.now, tikhub?: TikhubStep): Promise<SocialMonitorReport> {
  const report: SocialMonitorReport = { publishes: null, providerWork: null, attempts: null, sweep: null,
    sweepDeleteEnabled: false, pruned: null, refresh: null, tikhub: null, billedRunsClosed: null, billedPruned: null,
    postForMe: client !== null, failures: [] };
  try { report.pruned = await pruneSnapshots(db, until, now); } catch { report.failures.push('prune'); }
  try { report.billedPruned = await pruneBilledReads(db); } catch { report.failures.push('billed_prune'); }
  try {
    report.publishes = await reconcilePublishes(db, client, until, now);
  } catch { report.failures.push('publishes'); }
  try { report.billedRunsClosed = await closeOrphanRuns(db as SupabaseClient); } catch { report.failures.push('billed_runs'); }
  if (client) {
    try { report.providerWork = await runProviderWork(db, client, until, now); } catch { report.failures.push('provider_work'); }
    try { report.attempts = await cleanupAttempts(db, client, until, now); } catch { report.failures.push('attempts'); }
    if (now() < until) {
      try {
        if (await switchOn(db, PUBLISH_MONITOR_SWITCH)) report.refresh = await runRefresh(db, client, windowFor, until, now);
      } catch { report.failures.push('refresh'); }
    }
  }
  // The billed TikHub reads share the feature switch; whether TikHub may be called at all (switched on, priced, approved
  // by the staging window) is decided per read by its admission, and nothing is held when it is not.
  if (tikhub && now() < until) {
    try {
      if (await switchOn(db, PUBLISH_MONITOR_SWITCH)) {
        report.tikhub = await runTikhubRefresh(db as SupabaseClient, { env: tikhub.env }, tikhub.entitlement, until, now);
      }
    } catch { report.failures.push('tikhub'); }
  }
  if (client && now() < until) {
    try {
      report.sweepDeleteEnabled = await sweepDeleteEnabled(db);
      report.sweep = await sweepOrphans(db, client, report.sweepDeleteEnabled, until, now);
    } catch { report.failures.push('sweep'); }
  }
  return report;
}
