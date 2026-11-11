/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { swallow } from '../../lib/swallow';
import type { ClientDeps } from './postForMe/client';
import { deleteScheduledPost, getScheduledPost, moveScheduledPost, type ScheduledPost } from './postForMe/scheduledPosts';
import { jobView, PublishError, rpc, type PublishJob } from './publish';

/**
 * PUBLISH-SCHEDULE (migration 0517_publish_monitor_schedule): the schedule view, the user's cancel and reschedule, and
 * the cron step that checks each scheduled post before its time. The database owns every decision (lease, lock window,
 * time range, slots, credits); this layer talks to Post for Me. Post for Me sends due posts every 2 minutes and its
 * update re-creates the post, so nothing is changed from 10 minutes before the time (the database refuses it too).
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
const uuid = z.string().uuid();
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const LOCK_MS = 10 * 60_000;
export const PREFLIGHT_MS = 40 * 60_000;
const AFTER_MS = 5 * 60_000;
const RETRY_MS = 2 * 60_000;
const USER_LEASE_SECONDS = 120;
const iso = (ms: number) => new Date(ms).toISOString();

export type ScheduleEntry = PublishJob & { at: string };
const entry = jobView.and(z.object({ at: z.string() }).passthrough());

/** The user's publish jobs whose time falls in [from, to) (at most 43 days); the page picks the week in local time. */
export function listSchedule(db: Rpc, profileId: string, from: string, to: string): Promise<ScheduleEntry[]> {
  return rpc(db, 'publish_monitor_schedule_list', { a: uuid.parse(profileId), p_from: iso(Date.parse(from)),
    p_to: iso(Date.parse(to)) }, z.array(entry));
}

const begun = jobView.and(z.object({ lease: uuid.nullable(), providerPostId: providerId.nullable().optional(),
  mediaCount: z.number().int().nullable().optional(), providerAccountIds: z.array(providerId).optional() }).passthrough());
type Begun = z.infer<typeof begun>;
type Outcome = 'cancelled' | 'moved' | 'kept' | 'checked' | 'mark' | 'started' | 'later';

function finish(db: Rpc, jobId: string, lease: string, outcome: Outcome, at: string | null, code: string | null) {
  return rpc(db, 'publish_monitor_schedule_finish', { p_job: jobId, p_lease: lease, p_outcome: outcome, p_at: at,
    p_code: code }, jobView);
}
const unlease = (db: Rpc, jobId: string, lease: string) =>
  rpc(db, 'publish_monitor_publish_unlease', { p_job: jobId, p_lease: lease }, z.unknown());

/** The provider post is still the one Graylum sent: same accounts, same number of files, no overrides. */
export function sameContent(post: ScheduledPost, accounts: string[], mediaCount: number | null | undefined): boolean {
  return !post.hasOverrides && post.socialAccountIds.join(',') === [...accounts].sort().join(',')
    && (mediaCount === null || mediaCount === undefined || post.mediaCount === mediaCount);
}

function begin(db: Rpc, profileId: string, jobId: string, action: 'cancel' | 'reschedule', expectedAt: string,
  newAt: string | null): Promise<Begun> {
  return rpc(db, 'publish_monitor_schedule_begin', { a: uuid.parse(profileId), p_job: uuid.parse(jobId), p_action: action,
    p_expected_at: iso(Date.parse(expectedAt)), p_new_at: newAt === null ? null : iso(Date.parse(newAt)),
    p_lease_seconds: USER_LEASE_SECONDS }, begun);
}

/**
 * Cancels one scheduled post. The cancellation is recorded first, so if Post for Me cannot be reached now the cron step
 * finishes it; the hold returns in full once the provider post is gone. If sending already started, the job continues
 * as a sent one and is not charged (the user asked to cancel).
 */
export async function cancelScheduled(db: Rpc, deps: ClientDeps, profileId: string, jobId: string,
  expectedAt: string): Promise<PublishJob> {
  const job = await begin(db, profileId, jobId, 'cancel', expectedAt, null);
  if (!job.lease || !job.providerPostId) return job;
  const deleted = await deleteScheduledPost(deps, job.providerPostId);
  if (deleted.kind === 'ok' || (deleted.kind === 'rejected' && deleted.status === 404)) {
    return finish(db, jobId, job.lease, 'cancelled', null, null);
  }
  if (deleted.kind === 'rejected' && deleted.status === 400) return finish(db, jobId, job.lease, 'started', null, null);
  return finish(db, jobId, job.lease, 'kept', iso(Date.now() + RETRY_MS), 'PUBLISH_SCHEDULE_CANCEL_PENDING');
}

/**
 * Moves one scheduled post to `newAt`. The post is read first (it must still be scheduled, at the expected time, with
 * Graylum's content) and sent back whole with the new time. An answer that proves nothing leaves the job for the cron
 * step to verify (it adopts whatever time Post for Me then has).
 */
export async function rescheduleScheduled(db: Rpc, deps: ClientDeps, profileId: string, jobId: string, expectedAt: string,
  newAt: string): Promise<PublishJob> {
  const job = await begin(db, profileId, jobId, 'reschedule', expectedAt, newAt);
  if (!job.lease || !job.providerPostId) throw new PublishError('PUBLISH_SCHEDULE_CANCELLING');
  const lease = job.lease;
  const read = await getScheduledPost(deps, job.providerPostId);
  if (read.kind === 'rejected' && read.status === 404) {
    await finish(db, jobId, lease, 'cancelled', null, 'PUBLISH_SCHEDULE_PROVIDER_DELETED');
    throw new PublishError('PUBLISH_SCHEDULE_PROVIDER_CHANGED');
  }
  if (read.kind !== 'ok') {
    await unlease(db, jobId, lease);
    throw new PublishError('PUBLISH_MONITOR_PROVIDER_BUSY', read.kind === 'rate_limited' ? read.retryAfterSeconds : 30);
  }
  const post = read.value;
  if (post.status === 'processing' || post.status === 'processed') {
    await finish(db, jobId, lease, 'started', null, null);
    throw new PublishError('PUBLISH_SCHEDULE_LOCKED');
  }
  if (post.status !== 'scheduled' || post.scheduledAt !== iso(Date.parse(expectedAt))
    || !sameContent(post, job.providerAccountIds ?? [], job.mediaCount)) {
    // Not what Graylum sent: the cron step looks at it right away and cancels it if it cannot be trusted.
    await finish(db, jobId, lease, 'kept', iso(Date.now()), 'PUBLISH_SCHEDULE_VERIFY');
    throw new PublishError('PUBLISH_SCHEDULE_PROVIDER_CHANGED');
  }
  const moved = await moveScheduledPost(deps, post, jobId, newAt);
  const target = iso(Date.parse(newAt));
  if (moved.kind === 'ok' && moved.value.status === 'scheduled' && moved.value.scheduledAt === target
    && sameContent(moved.value, job.providerAccountIds ?? [], job.mediaCount)) {
    return finish(db, jobId, lease, 'moved', target, null);
  }
  if (moved.kind === 'rejected' && moved.status === 404) {
    await finish(db, jobId, lease, 'cancelled', null, 'PUBLISH_SCHEDULE_PROVIDER_DELETED');
    throw new PublishError('PUBLISH_SCHEDULE_PROVIDER_CHANGED');
  }
  // A definite refusal (validation runs before Post for Me touches the post) or our limiter: nothing changed.
  if (moved.kind === 'rejected' || (moved.kind === 'rate_limited' && !moved.sent)) {
    await unlease(db, jobId, lease);
    throw moved.kind === 'rejected' ? new PublishError('PUBLISH_SCHEDULE_TIME_INVALID')
      : new PublishError('PUBLISH_MONITOR_PROVIDER_BUSY', moved.retryAfterSeconds);
  }
  logger.warn('api', 'publish_schedule_move_unverified', { jobId, kind: moved.kind });
  return finish(db, jobId, lease, 'kept', iso(Date.now()), 'PUBLISH_SCHEDULE_VERIFY');
}

const claimItem = z.object({ jobId: uuid, lease: uuid, actorId: uuid, providerPostId: providerId, scheduledAt: z.string(),
  mediaCount: z.number().int().nullable(), cancelReason: z.string().nullable(), preflightDone: z.boolean(),
  providerAccountIds: z.array(providerId) }).strict();
type ClaimItem = z.infer<typeof claimItem>;
export type ScheduleReport = { processed: number; cancelled: number; moved: number; started: number; checked: number;
  deferred: number; stopped?: 'deadline' | 'provider_busy' };
/** Whether the user may publish now (membership plan); null when it cannot be read. */
export type PublishAllowed = (actorId: string) => Promise<boolean | null>;
const BATCH = 25;
const MAX_BATCHES = 20;

/**
 * Cron step: every scheduled job that is due or whose targets or account stopped being usable. Before the lock window
 * it cancels what must not go out (user request, target changed, account closed, membership ended, post changed at
 * Post for Me); 40 minutes before the time it checks the membership; after the time it hands sent posts to the
 * publish reconciliation. Settling never waits for the feature switch.
 */
export async function runScheduleChecks(db: Rpc, deps: ClientDeps, allowed: PublishAllowed, until: number,
  now: () => number = Date.now): Promise<ScheduleReport> {
  const report: ScheduleReport = { processed: 0, cancelled: 0, moved: 0, started: 0, checked: 0, deferred: 0 };
  const plans = new Map<string, Promise<boolean | null>>();
  const allowedOnce = (actorId: string) => {
    if (!plans.has(actorId)) plans.set(actorId, swallow('publish_schedule_plan_unreadable', allowed(actorId), null));
    return plans.get(actorId)!;
  };
  for (let batch = 0; batch < MAX_BATCHES && now() < until; batch += 1) {
    const items = await rpc(db, 'publish_monitor_schedule_claim', { p_limit: BATCH, p_lease_seconds: 300 },
      z.array(claimItem));
    for (const [index, item] of items.entries()) {
      const result = now() >= until ? 'untouched' : await checkOne(db, deps, item, allowedOnce, now, report);
      if (result === 'untouched' || result === 'busy') {
        // Hand the untried jobs back unchanged; the next run picks them up.
        const rest = result === 'untouched' ? items.slice(index) : items.slice(index + 1);
        for (const other of rest) await unlease(db, other.jobId, other.lease);
        report.stopped = result === 'untouched' ? 'deadline' : 'provider_busy';
        return report;
      }
    }
    if (items.length < BATCH) break;
  }
  return report;
}

async function checkOne(db: Rpc, deps: ClientDeps, item: ClaimItem, allowed: PublishAllowed, now: () => number,
  report: ScheduleReport): Promise<'done' | 'busy'> {
  const t = now(), at = Date.parse(item.scheduledAt), locked = t >= at - LOCK_MS;
  const end = (outcome: Outcome, when: number | null, code: string | null) =>
    finish(db, item.jobId, item.lease, outcome, when === null ? null : iso(when), code);
  const read = await getScheduledPost(deps, item.providerPostId);
  if (read.kind === 'rate_limited') {
    await unlease(db, item.jobId, item.lease);
    return 'busy';
  }
  report.processed += 1;
  if (read.kind === 'rejected' && read.status === 404) {
    // Gone at Post for Me before its time (deleted with its account, or by a cancel whose answer was lost): not sent.
    if (t < at) report.cancelled += 1; else report.started += 1;
    await (t < at ? end('cancelled', null, 'PUBLISH_SCHEDULE_PROVIDER_DELETED') : end('started', null, null));
    return 'done';
  }
  if (read.kind !== 'ok') {
    report.deferred += 1;
    await end('later', null, 'PUBLISH_SCHEDULE_CHECK_FAILED');
    return 'done';
  }
  const post = read.value;
  if (post.status === 'processing' || post.status === 'processed') {
    report.started += 1;
    await end('started', null, null);
    return 'done';
  }
  const trusted = post.status === 'scheduled' && post.scheduledAt !== null
    && sameContent(post, item.providerAccountIds, item.mediaCount);
  let reason = item.cancelReason ?? (trusted ? null : 'PUBLISH_SCHEDULE_PROVIDER_CHANGED');
  if (!reason && !item.preflightDone && t >= at - PREFLIGHT_MS) {
    const plan = await allowed(item.actorId);
    if (plan === null) {
      report.deferred += 1;
      await end('later', null, 'PUBLISH_SCHEDULE_PLAN_UNREADABLE');
      return 'done';
    }
    if (!plan) reason = 'PUBLISH_SCHEDULE_MEMBERSHIP_ENDED';
  }
  if (reason) return cancelBeforeTime(item, reason, locked, t, at, deps, end, report);
  if (post.scheduledAt !== iso(at)) {
    // Post for Me has another time (a reschedule whose answer was lost): it is the truth.
    report.moved += 1;
    await end('moved', Date.parse(post.scheduledAt!), null);
    return 'done';
  }
  if (t < at - PREFLIGHT_MS) {
    report.deferred += 1;
    await end('kept', at - PREFLIGHT_MS, null);
  } else if (!item.preflightDone) {
    report.checked += 1;
    await end('checked', at + AFTER_MS, null);
  } else if (t > at + 24 * 3600_000) {
    // Still waiting a day after its time: the backoff marks it for manual review.
    report.deferred += 1;
    await end('later', null, 'PUBLISH_SCHEDULE_NOT_SENT');
  } else {
    report.deferred += 1;
    await end('kept', Math.max(t, at) + AFTER_MS, null);
  }
  return 'done';
}

async function cancelBeforeTime(item: ClaimItem, reason: string, locked: boolean, t: number, at: number,
  deps: ClientDeps, end: (o: Outcome, when: number | null, code: string | null) => Promise<PublishJob>,
  report: ScheduleReport): Promise<'done' | 'busy'> {
  // Inside the lock window nothing is changed at Post for Me; the reason is kept so a post sent anyway is not charged.
  if (locked) {
    report.deferred += 1;
    await end('mark', Math.max(t, at) + AFTER_MS, reason);
    return 'done';
  }
  const deleted = await deleteScheduledPost(deps, item.providerPostId);
  if (deleted.kind === 'ok' || (deleted.kind === 'rejected' && deleted.status === 404)) {
    report.cancelled += 1;
    await end('cancelled', null, reason);
    return 'done';
  }
  if (deleted.kind === 'rejected' && deleted.status === 400) {
    // Sending started after all: reconciled as sent, with the reason kept so it is not charged.
    report.started += 1;
    await end('started', null, reason);
    return 'done';
  }
  report.deferred += 1;
  await end('mark', t + RETRY_MS, reason);
  return deleted.kind === 'rate_limited' ? 'busy' : 'done';
}
