/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { readMembershipEntitlements } from '../membershipEntitlements';
import type { SocialPlatform } from '../research/vendors/types';
import { billedTikhubRead, settleLeftOpenRun, type BilledReadDeps } from './billedRead';
import { applyTikhubRead, tikhubClaimSchema, type TikhubClaim } from './tikhub';

/**
 * PUBLISH-MONITOR PR-4b (plan §4.2, §6, §8): the daily TikHub step of `/api/cron/social-monitor`. Own Xiaohongshu/Douyin
 * accounts (with automatic tracking) and Gold benchmark accounts are read once a UTC day, each read billed per call at
 * the frozen price. The entitlement is checked again for every claim: an own account needs a data window, a benchmark
 * needs Gold. A balance too low for the next call settles the connection as "余额不足，未更新" without holding anything.
 */
type Db = SupabaseClient;
export type TikhubEntitlement = { windowDays: number; benchmark: boolean };
export type TikhubEntitlementLookup = (actorId: string) => Promise<TikhubEntitlement>;
export type TikhubReport = { claimed: number; outcomes: Record<string, number>; orphansClosed: number };

/** Server-side entitlement for the daily step; an account that is no longer usable has none. */
export function tikhubEntitlements(client: SupabaseClient): TikhubEntitlementLookup {
  return async actorId => {
    try {
      const e = await readMembershipEntitlements(client, actorId);
      return { windowDays: e.ownDataWindowDays, benchmark: e.allowBenchmarkMonitor };
    } catch (error) {
      if (error instanceof TRPCError && error.code === 'FORBIDDEN') return { windowDays: 0, benchmark: false };
      throw error;
    }
  };
}

async function settle(db: Db, claim: TikhubClaim, outcome: 'entitlement' | 'release' | 'failed', error: string | null = null) {
  const result = await db.rpc('publish_monitor_refresh_finish', { p_connection_id: claim.connectionId, p_lease: claim.lease,
    p_refresh_id: claim.refreshId, p_outcome: outcome, p_error: error });
  if (result.error) throw new Error('PUBLISH_MONITOR_TIKHUB_UNAVAILABLE');
}

/** Closes runs a killed process left open, so no hold stays frozen (bounded per job run). */
export async function closeOrphanRuns(db: Db): Promise<number> {
  const listed = await db.rpc('publish_monitor_billed_orphans', { p_limit: 50 });
  if (listed.error) throw new Error('PUBLISH_MONITOR_TIKHUB_UNAVAILABLE');
  const rows = z.array(z.object({ connectionId: z.string().uuid(), actorId: z.string().uuid(), runId: z.string().uuid(),
    policies: z.array(z.unknown()) }).strict()).parse(listed.data);
  for (const row of rows) await settleLeftOpenRun(db, { actorId: row.actorId }, row.runId, row.policies);
  return rows.length;
}

export async function runTikhubRefresh(db: Db, deps: Omit<BilledReadDeps, 'admin'>, entitlementFor: TikhubEntitlementLookup,
  until: number, now: () => number = Date.now): Promise<TikhubReport> {
  const report: TikhubReport = { claimed: 0, outcomes: {}, orphansClosed: await closeOrphanRuns(db) };
  const count = (key: string) => { report.outcomes[key] = (report.outcomes[key] ?? 0) + 1; };
  const rights = new Map<string, TikhubEntitlement | null>();
  let stop = false;
  while (!stop && now() < until) {
    const claimed = await db.rpc('publish_monitor_tikhub_claim', { p_limit: 5, p_lease_seconds: 300 });
    if (claimed.error) throw new Error('PUBLISH_MONITOR_TIKHUB_UNAVAILABLE');
    const batch = z.array(tikhubClaimSchema).parse(claimed.data);
    if (!batch.length) break;
    report.claimed += batch.length;
    for (const claim of batch) {
      if (stop || now() >= until) { await settle(db, claim, 'release'); count('release'); continue; }
      if (!rights.has(claim.actorId)) rights.set(claim.actorId, await entitlementFor(claim.actorId).catch(() => null));
      const right = rights.get(claim.actorId);
      // Unreadable entitlement: leave it for the next run rather than guess (and stop: the next claim is the same row).
      if (!right) { await settle(db, claim, 'release'); count('release'); stop = true; continue; }
      if (claim.role === 'own' ? right.windowDays <= 0 : !right.benchmark) { await settle(db, claim, 'entitlement'); count('entitlement'); continue; }
      const keys = { connectionId: claim.connectionId, actorId: claim.actorId, lease: claim.lease, refreshId: claim.refreshId };
      const read = await billedTikhubRead({ ...deps, admin: db }, keys, claim.platform as SocialPlatform, claim.account);
      if (read.kind === 'stale') { count('stale'); continue; }
      if (read.kind === 'insufficient_credits') {
        const done = await db.rpc('publish_monitor_refresh_insufficient', { p_connection_id: claim.connectionId, p_lease: claim.lease,
          p_refresh_id: claim.refreshId });
        if (done.error) throw new Error('PUBLISH_MONITOR_TIKHUB_UNAVAILABLE');
        count('insufficient_credits');
        continue;
      }
      if (read.kind === 'unavailable') {
        // Switched off, unpriced, not approved or rate-limited: the same holds for every later claim of this run.
        await settle(db, claim, 'release'); count('release'); stop = true; continue;
      }
      const posts = read.results.account_posts;
      if (!posts) { await settle(db, claim, 'failed', 'TIKHUB_NO_POST_READ'); count('failed'); continue; }
      const applied = await applyTikhubRead(db, claim, read.results.account_profile ?? null, posts,
        `tikhub:${claim.refreshId}`);
      count(applied ? 'read' : 'stale');
    }
  }
  return report;
}
