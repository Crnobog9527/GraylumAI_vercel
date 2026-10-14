/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import {
  deleteAccount, disconnectAccount, getAccount, listAccountsByExternalId, listAllAccounts,
  type AccountPage, type ClientDeps, type Outcome, type PostForMeAccount,
} from './postForMe/client';

/**
 * PUBLISH-MONITOR PR-2c-1 (plan §4.1, §7, migration 0265): the provider side of cleanup, run by the daily job (2c-2).
 * The database decides ownership; this layer only reads Post for Me, carries out the decision, and reports progress.
 * Every list is read completely before anything is deleted (plan §9 item 22: deleting shifts later pages).
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
type Clock = () => number;
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const MAX_ACCOUNTS = 5000;
const LEASE_SECONDS = 300;

export class CleanupError extends Error {
  constructor(readonly code: 'PUBLISH_MONITOR_CLEANUP_UNAVAILABLE') { super(code); }
}

async function rpc<T>(db: Rpc, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const result = await db.rpc(name, args);
  if (result.error) throw new CleanupError('PUBLISH_MONITOR_CLEANUP_UNAVAILABLE');
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new CleanupError('PUBLISH_MONITOR_CLEANUP_UNAVAILABLE');
  return parsed.data;
}

/**
 * Reads every page; null when any page fails or the deadline passes before the last page (the caller retries
 * later rather than acting on a partial list). No new page is started after the deadline.
 */
async function listAll(read: (offset: number) => Promise<Outcome<AccountPage>>, until: number,
  now: Clock): Promise<PostForMeAccount[] | null> {
  const accounts: PostForMeAccount[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    if (now() >= until) return null;
    const page = await read(offset);
    if (page.kind !== 'ok') return null;
    accounts.push(...page.value.accounts);
    if (accounts.length > MAX_ACCOUNTS) return null;
    offset = page.value.nextOffset;
  }
  return accounts;
}

const gone = (outcome: Outcome<unknown>) => outcome.kind === 'rejected' && outcome.status === 404;
const errorCode = (outcome: Outcome<unknown>) => outcome.kind === 'rate_limited' ? 'PROVIDER_BUSY'
  : outcome.kind === 'rejected' ? `PROVIDER_REJECTED_${outcome.status}` : 'PROVIDER_UNAVAILABLE';

/** Deletes one account only while it still carries `externalId` (re-read right before deleting). */
async function deleteIfStill(client: ClientDeps, id: string, externalId: string): Promise<'done' | 'retry'> {
  const current = await getAccount(client, id);
  if (gone(current)) return 'done';
  if (current.kind !== 'ok') return 'retry';
  if (current.value.externalId !== externalId) return 'done';
  const removed = await deleteAccount(client, id);
  return removed.kind === 'ok' || gone(removed) ? 'done' : 'retry';
}

const claimedAttempt = z.object({ requestId: z.string().uuid(), externalId: z.string(), platform: z.string(),
  candidateIds: z.array(providerId) }).strict();
const verdict = z.object({ providerAccountId: providerId, action: z.enum(['delete', 'keep', 'skip', 'takeover']) }).strict();

export type RunReport = { processed: number; settled: number; deferred: number };

/** Settles attempts that can no longer be used: new accounts they imported are deleted, takeovers queued. */
export async function cleanupAttempts(db: Rpc, client: ClientDeps, until: number, now: Clock = Date.now): Promise<RunReport> {
  const report: RunReport = { processed: 0, settled: 0, deferred: 0 };
  if (now() >= until) return report;
  const attempts = await rpc(db, 'publish_monitor_cleanup_claim', { p_limit: 50, p_lease_seconds: LEASE_SECONDS },
    z.array(claimedAttempt));
  for (const attempt of attempts) {
    if (now() >= until) break;
    report.processed += 1;
    let error: string | null = null;
    const accounts = await listAll(offset => listAccountsByExternalId(client, attempt.externalId, offset), until, now);
    if (!accounts) error = 'PROVIDER_LIST_FAILED';
    else {
      const verdicts = await rpc(db, 'publish_monitor_cleanup_classify', { p_request_id: attempt.requestId,
        p_accounts: accounts.map(a => ({ providerAccountId: a.id, externalId: a.externalId })) }, z.array(verdict));
      for (const v of verdicts.filter(x => x.action === 'delete')) {
        if (now() >= until || (await deleteIfStill(client, v.providerAccountId, attempt.externalId)) === 'retry') {
          error = 'PROVIDER_DELETE_PENDING';
          break;
        }
      }
    }
    await rpc(db, 'publish_monitor_cleanup_finish', { p_request_id: attempt.requestId, p_done: error === null,
      p_error: error }, z.unknown());
    if (error) report.deferred += 1; else report.settled += 1;
  }
  return report;
}

const claimedWork = z.object({ connectionId: z.string().uuid(), lease: z.string().uuid(), providerAccountId: providerId,
  deleting: z.boolean(),
  takeoverPending: z.boolean(),
  action: z.enum(['delete', 'disconnect']), ownerRef: z.string().regex(/^[0-9a-f]{32}$/).nullable() }).strict();
type WorkOutcome = 'deleted' | 'gone' | 'owner_changed' | 'disconnected' | 'owner_back' | 'retry';

/**
 * One claimed connection. The account is always re-read first and acted on only while it still carries the expected
 * owner's reference: a deletion record is deleted (or, while its owner's publishes are unresolved, only disconnected)
 * only if the record's owner still authorizes it; a takeover is disconnected only if the original owner does not.
 */
async function settle(client: ClientDeps, job: z.infer<typeof claimedWork>): Promise<[WorkOutcome, string | null]> {
  const current = await getAccount(client, job.providerAccountId);
  // A held deletion (publishes unresolved) stays held even when the account is already gone.
  if (gone(current)) return [job.deleting && job.action === 'disconnect' ? 'disconnected' : 'gone', null];
  if (current.kind !== 'ok') return ['retry', errorCode(current)];
  const owner = current.value.externalId?.split('.')[0] ?? null;
  if (job.deleting) {
    if (!job.ownerRef) return ['retry', 'OWNER_UNKNOWN'];
    if (owner !== job.ownerRef) {
      // While this record holds the provider account ID no other Graylum connection can bind it, so a different
      // owner is always an unconfirmed overwrite: its grant is cleared before the record ends (or is held while its
      // owner's publishes are unresolved, action 'disconnect').
      const settled: WorkOutcome = job.action === 'disconnect' ? 'disconnected' : 'owner_changed';
      if (current.value.status === 'disconnected') return [settled, null];
      const cleared = await disconnectAccount(client, job.providerAccountId);
      return cleared.kind === 'ok' || gone(cleared) ? [settled, null] : ['retry', errorCode(cleared)];
    }
  } else if (job.ownerRef && owner === job.ownerRef) {
    // The original owner re-authorised since the takeover: their fresh grant is not ours to revoke.
    return ['owner_back', null];
  }
  if (job.action === 'disconnect' && current.value.status === 'disconnected') return ['disconnected', null];
  const result = job.action === 'delete'
    ? await deleteAccount(client, job.providerAccountId) : await disconnectAccount(client, job.providerAccountId);
  if (result.kind === 'ok') return [job.action === 'delete' ? 'deleted' : 'disconnected', null];
  if (gone(result)) return ['gone', null];
  return ['retry', errorCode(result)];
}

/** Provider deletions of 'deleting' connections and disconnects of proven takeovers, retried until settled. */
export async function runProviderWork(db: Rpc, client: ClientDeps, until: number, now: Clock = Date.now): Promise<RunReport> {
  const report: RunReport = { processed: 0, settled: 0, deferred: 0 };
  if (now() >= until) return report;
  const jobs = await rpc(db, 'publish_monitor_provider_work_claim', { p_limit: 50, p_lease_seconds: LEASE_SECONDS },
    z.array(claimedWork));
  for (const job of jobs) {
    if (now() >= until) break;
    report.processed += 1;
    const [outcome, error] = await settle(client, job);
    await rpc(db, 'publish_monitor_provider_work_finish', { p_connection_id: job.connectionId, p_lease: job.lease,
      p_outcome: outcome,
      p_error: error }, z.unknown());
    if (outcome === 'retry') report.deferred += 1; else report.settled += 1;
  }
  return report;
}

export type SweepReport = { listed: number; orphans: number; deleted: number; unknownFormat: number; deferred: number;
  /** Bound accounts found carrying another user's reference: quarantined and queued for disconnect. */
  takenOver: number;
  /** The listing did not finish before the deadline; nothing was decided or deleted this run. */
  incomplete?: true };

/**
 * Daily backstop: accounts in the provider project that nothing in Graylum explains. Deleting is opt-in per
 * environment (`deleteEnabled`, an admin switch) because another environment or a manually connected test account
 * may share the project; otherwise orphans are only counted. Unknown external_id formats are never deleted.
 */
export async function sweepOrphans(db: Rpc, client: ClientDeps, deleteEnabled: boolean, until: number,
  now: Clock = Date.now): Promise<SweepReport> {
  const accounts = await listAll(offset => listAllAccounts(client, offset), until, now);
  if (!accounts && now() >= until) {
    return { listed: 0, orphans: 0, deleted: 0, unknownFormat: 0, deferred: 0, takenOver: 0, incomplete: true };
  }
  if (!accounts) throw new CleanupError('PUBLISH_MONITOR_CLEANUP_UNAVAILABLE');
  const decision = await rpc(db, 'publish_monitor_orphan_classify', {
    p_accounts: accounts.map(a => ({ providerAccountId: a.id, externalId: a.externalId, status: a.status })),
  }, z.object({ delete: z.array(providerId), unknownFormat: z.array(providerId), takenOver: z.array(providerId) }).strict());
  const report: SweepReport = { listed: accounts.length, orphans: decision.delete.length, deleted: 0,
    unknownFormat: decision.unknownFormat.length, deferred: 0, takenOver: decision.takenOver.length };
  if (deleteEnabled) {
    const byId = new Map(accounts.map(a => [a.id, a.externalId]));
    for (const id of decision.delete) {
      const externalId = byId.get(id);
      if (now() >= until || !externalId || (await deleteIfStill(client, id, externalId)) === 'retry') report.deferred += 1;
      else report.deleted += 1;
    }
  }
  if (report.orphans > 0 || report.unknownFormat > 0 || report.takenOver > 0) {
    logger.warn('api', 'publish_monitor_orphan_sweep', { ...report, deleteEnabled });
  }
  return report;
}
