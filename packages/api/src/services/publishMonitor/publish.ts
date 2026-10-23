/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { getAccount, type ClientDeps, type Outcome } from './postForMe/client';
import { publicHttpsUrl } from './postForMe/http';
import { createPost, createUploadUrl, findPostByExternalId, listPostResults, type UploadSlot } from './postForMe/posts';

/**
 * PUBLISH-MONITOR PR-5 one-click publishing (plan §2.1, §6, §9 items 7/8/17/18; migration 0274).
 * The database owns every decision (idempotency, targets, slots, credits, states); this layer reads and writes
 * Post for Me. The caption and media URLs only pass through this request: nothing of them is stored or logged.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
const uuid = z.string().uuid();
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const MAX_CAPTION = 5000;
const MAX_MEDIA_ITEMS = 10;
export const MAX_MEDIA_BYTES = 1024 ** 3;
const MAX_COVER_MS = 24 * 3600 * 1000;
const media = z.object({
  // The public URL Post for Me returned with the upload slot; a retry must upload again (plan §2.1).
  mediaUrl: z.string().max(2048).refine(url => publicHttpsUrl(url) !== null, 'MEDIA_URL_NOT_PUBLIC_HTTPS'),
  // Identifies the file for the idempotency fingerprint, so a re-upload of the same file is the same request. The browser
  // hashes the size plus the first and last 4 MB (bounded memory for large videos); identity only, not integrity.
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  // Post for Me support (Caleb, 2026-10): about 1 GB per file; the server transcodes per platform.
  size: z.number().int().positive().max(MAX_MEDIA_BYTES),
  mimeType: z.string().regex(/^(image|video)\/[a-z0-9.+-]{1,64}$/),
  // Video cover: the frame at this time. Platforms without cover support get a screenshot at it (Post for Me answer).
  thumbnailTimestampMs: z.number().int().min(0).max(MAX_COVER_MS).optional(),
}).strict().refine(item => item.thumbnailTimestampMs === undefined || item.mimeType.startsWith('video/'),
  'COVER_ONLY_FOR_VIDEO');

export const publishInput = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  businessId: uuid,
  workItemId: uuid.nullable(),
  connectionIds: z.array(uuid).min(1).max(9),
  caption: z.string().min(1).max(MAX_CAPTION),
  // The most credits the user approved holding for this publish (the confirmation dialog). Not part of the fingerprint:
  // a replay returns the existing job whatever the price is now.
  maxHoldCredits: z.number().int().min(0).max(1_000_000),
  media: z.array(media).max(MAX_MEDIA_ITEMS),
}).strict();
export type PublishInput = z.infer<typeof publishInput>;

const targetView = z.object({ connectionId: uuid, platform: z.string(), status: z.enum(['pending', 'published', 'failed']),
  url: z.string().nullable().optional() }).strict();
export const jobView = z.object({
  id: uuid, state: z.enum(['claimed', 'dispatching', 'unknown', 'completed', 'failed', 'released']),
  businessId: uuid.nullable(), workItemId: uuid.nullable(), targets: z.array(targetView),
  holdCredits: z.number().int().nullable(), chargedCredits: z.number().int().nullable(), manualReview: z.boolean(),
  errorCode: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
}).passthrough();
export type PublishJob = z.infer<typeof jobView>;

export type PublishErrorCode = 'PUBLISH_MONITOR_IDEMPOTENCY_MISMATCH' | 'PUBLISH_MONITOR_TARGET_INVALID'
  | 'PUBLISH_MONITOR_WORK_ITEM_INVALID' | 'PUBLISH_MONITOR_QUOTA_EXHAUSTED' | 'PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED'
  | 'PUBLISH_MONITOR_PRICE_NOT_CONFIGURED' | 'PUBLISH_MONITOR_INSUFFICIENT_CREDITS' | 'PUBLISH_MONITOR_TOO_MANY_REJECTIONS'
  | 'PUBLISH_MONITOR_JOB_NOT_FOUND' | 'PUBLISH_MONITOR_ACCOUNT_CLOSED' | 'PUBLISH_MONITOR_PROVIDER_BUSY'
  | 'PUBLISH_MONITOR_PLATFORM_NOT_OPEN' | 'PUBLISH_MONITOR_PRICE_CHANGED' | 'PUBLISH_MONITOR_UNAVAILABLE';
const KNOWN: PublishErrorCode[] = ['PUBLISH_MONITOR_IDEMPOTENCY_MISMATCH', 'PUBLISH_MONITOR_TARGET_INVALID',
  'PUBLISH_MONITOR_WORK_ITEM_INVALID', 'PUBLISH_MONITOR_QUOTA_EXHAUSTED', 'PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED',
  'PUBLISH_MONITOR_PRICE_NOT_CONFIGURED', 'PUBLISH_MONITOR_INSUFFICIENT_CREDITS', 'PUBLISH_MONITOR_TOO_MANY_REJECTIONS',
  'PUBLISH_MONITOR_JOB_NOT_FOUND', 'PUBLISH_MONITOR_ACCOUNT_CLOSED'];

export class PublishError extends Error {
  constructor(readonly code: PublishErrorCode, readonly retryAfterSeconds?: number) { super(code); }
}

async function rpc<T>(db: Rpc, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const result = await db.rpc(name, args);
  if (result.error) {
    const known = KNOWN.find(code => result.error?.message?.includes(code));
    throw new PublishError(known ?? 'PUBLISH_MONITOR_UNAVAILABLE');
  }
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new PublishError('PUBLISH_MONITOR_UNAVAILABLE');
  return parsed.data;
}

/** Plan §9 item 18: the key is bound to the normalized request (brand, item, targets, caption, files by content). */
export function publishFingerprint(input: PublishInput): string {
  const canonical = JSON.stringify({
    businessId: input.businessId, workItemId: input.workItemId, connectionIds: [...input.connectionIds].sort(),
    caption: input.caption.normalize('NFC'),
    // The cover is part of the request only when chosen, so fingerprints of requests without one stay unchanged.
    media: input.media.map(item => ({ sha256: item.sha256, size: item.size, mimeType: item.mimeType,
      ...(item.thumbnailTimestampMs === undefined ? {} : { thumbnailTimestampMs: item.thumbnailTimestampMs }) })),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

const claimed = jobView.and(z.object({ replayed: z.boolean(), quotaAlert: z.boolean().optional() }).passthrough());
const dispatched = jobView.and(z.object({ dispatch: z.boolean(),
  providerAccountIds: z.array(providerId).optional() }).passthrough());

const busy = (outcome: Outcome<unknown>) => new PublishError('PUBLISH_MONITOR_PROVIDER_BUSY',
  outcome.kind === 'rate_limited' ? outcome.retryAfterSeconds : 30);

/**
 * The site-wide limiter allows 4 provider calls per second; a 9-target publish needs 10. A short wait (the limiter's
 * one-second window) is spent here instead of failing, within a bounded budget, so a large publish never keeps
 * consuming the same window on every retry while its credits and slots stay reserved.
 */
export type Pacing = { sleep(ms: number): Promise<void>; now(): number; budgetMs: number };
const realPacing: Pacing = { sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now, budgetMs: 15_000 };
const SHORT_WAIT_SECONDS = 2;

async function paced<T>(pacing: Pacing, call: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
  const until = pacing.now() + pacing.budgetMs;
  for (;;) {
    const outcome = await call();
    if (outcome.kind !== 'rate_limited' || outcome.retryAfterSeconds > SHORT_WAIT_SECONDS
      || pacing.now() + outcome.retryAfterSeconds * 1000 > until) return outcome;
    await pacing.sleep(outcome.retryAfterSeconds * 1000);
  }
}

async function acquirePaced(deps: ClientDeps, pacing: Pacing): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const outcome = await paced(pacing, async (): Promise<Outcome<true>> => {
    const slot = await deps.limiter.acquire();
    return slot.ok ? { kind: 'ok', value: true } : { kind: 'rate_limited', retryAfterSeconds: slot.retryAfterSeconds, sent: false };
  });
  return outcome.kind === 'ok' ? { ok: true } : { ok: false, retryAfterSeconds: outcome.kind === 'rate_limited' ? outcome.retryAfterSeconds : 5 };
}

/**
 * What Post for Me says about each target account right now (plan §4.1: check the owner before every publish).
 * A transient read failure stops here and leaves the job claimed, so the same request can try again.
 */
async function observeTargets(deps: ClientDeps, ids: string[],
  pacing: Pacing): Promise<Record<string, { ownerRef: string | null; connected: boolean }>> {
  const observed: Record<string, { ownerRef: string | null; connected: boolean }> = {};
  for (const id of ids) {
    const account = await paced(pacing, () => getAccount(deps, id));
    if (account.kind === 'rejected' && account.status === 404) {
      observed[id] = { ownerRef: null, connected: false };
      continue;
    }
    if (account.kind !== 'ok') throw busy(account);
    const ownerRef = account.value.externalId?.split('.')[0] ?? null;
    observed[id] = { ownerRef: ownerRef && /^[0-9a-f]{32}$/.test(ownerRef) ? ownerRef : null,
      connected: account.value.status === 'connected' };
  }
  return observed;
}

/**
 * Submits one publish request. A replay with the same key and content returns the existing job and never sends again,
 * except a job that is still only claimed (interrupted before sending), which this same request may send now.
 */
export async function submitPublish(db: Rpc, deps: ClientDeps, profileId: string, raw: PublishInput,
  pacing: Pacing = realPacing): Promise<PublishJob> {
  const input = publishInput.parse(raw);
  const job = await rpc(db, 'publish_monitor_publish_claim', { a: uuid.parse(profileId), p_key: input.idempotencyKey,
    p_fingerprint: publishFingerprint(input), p_business: input.businessId, p_work_item: input.workItemId,
    p_connections: input.connectionIds }, claimed);
  if (job.quotaAlert) logger.warn('api', 'publish_monitor_quota_80_percent', { jobId: job.id });
  if (job.state !== 'claimed') return job;
  // The price is read by the claim itself: a price raised after the user confirmed must not charge more than approved.
  // Nothing was sent, so the new job is released at once (its hold and slots return) and the user confirms again.
  if (!job.replayed && job.holdCredits !== null && job.holdCredits > input.maxHoldCredits) {
    await releaseProven(db, job.id, 'PUBLISH_MONITOR_PRICE_CHANGED', pacing);
    throw new PublishError('PUBLISH_MONITOR_PRICE_CHANGED');
  }
  const ids = await targetAccountIds(db, profileId, job.id);
  const observed = await observeTargets(deps, ids, pacing);
  // The slot for the create call is taken before the job is marked as possibly sent.
  const slot = await acquirePaced(deps, pacing);
  if (!slot.ok) throw new PublishError('PUBLISH_MONITOR_PROVIDER_BUSY', slot.retryAfterSeconds);
  const ready = await rpc(db, 'publish_monitor_publish_dispatch', { a: profileId, p_job: job.id, p_observed: observed },
    dispatched);
  if (!ready.dispatch || !ready.providerAccountIds) return ready;
  let created: Awaited<ReturnType<typeof createPost>>;
  try {
    created = await createPost(deps, { externalId: job.id, caption: input.caption,
      socialAccountIds: ready.providerAccountIds,
      media: input.media.map(item => ({ url: item.mediaUrl, thumbnailTimestampMs: item.thumbnailTimestampMs })) });
  } catch {
    // createPost only throws while checking its input, before any request: provably not sent, so release now.
    return releaseProven(db, job.id, 'PUBLISH_MONITOR_REQUEST_INVALID', pacing);
  }
  if (created.kind === 'rejected') {
    return releaseProven(db, job.id, `PUBLISH_MONITOR_PROVIDER_REJECTED_${created.status}`, pacing);
  }
  if (created.kind === 'unknown') {
    logger.warn('api', 'publish_monitor_publish_unknown', { jobId: job.id, reason: created.reason });
    return rpc(db, 'publish_monitor_publish_unknown', { p_job: job.id, p_code: 'PUBLISH_MONITOR_RESULT_UNKNOWN' }, jobView);
  }
  return rpc(db, 'publish_monitor_publish_record', { p_job: job.id, p_provider_post_id: created.providerPostId,
    p_results: {} }, jobView);
}

/**
 * This request proved nothing was sent: release now, retrying the (idempotent) release a few times, because a job left
 * in "dispatching" could only be settled by an admin later while the user's credits stay frozen.
 */
async function releaseProven(db: Rpc, jobId: string, code: string, pacing: Pacing): Promise<PublishJob> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rpc(db, 'publish_monitor_publish_release', { p_job: jobId, p_code: code }, jobView);
    } catch (error) {
      if (attempt >= 3) {
        logger.error('api', 'publish_monitor_release_failed', { jobId, code });
        throw error;
      }
      await pacing.sleep(500 * attempt);
    }
  }
}

const accountIds = z.object({ providerAccountIds: z.array(providerId).min(1).max(9) }).passthrough();
/** The provider account of each target, read through the dispatch-free job lookup (never shown to the user). */
async function targetAccountIds(db: Rpc, profileId: string, jobId: string): Promise<string[]> {
  return (await rpc(db, 'publish_monitor_publish_targets', { a: profileId, p_job: jobId }, accountIds)).providerAccountIds;
}

type ReconcileTarget = { connectionId: string; providerAccountId: string };

/**
 * Asks Post for Me what happened to a dispatched job and records every final per-target result. Returns false when
 * nothing could be learned (not found yet, or the provider could not be read); the caller backs off.
 */
async function checkWithProvider(db: Rpc, deps: ClientDeps, jobId: string, providerPostId: string | null,
  targets: ReconcileTarget[]): Promise<{ learned: boolean; busy: boolean; code: string; job: PublishJob | null }> {
  let postId = providerPostId;
  if (!postId) {
    const found = await findPostByExternalId(deps, jobId);
    // Rate limited (our limiter or the provider's 429): no answer about the post, so this is no evidence at all.
    if (found.kind === 'rate_limited') return { learned: false, busy: true, code: 'PUBLISH_MONITOR_PROVIDER_BUSY', job: null };
    if (found.kind !== 'ok') return { learned: false, busy: false, code: 'PUBLISH_MONITOR_CHECK_FAILED', job: null };
    if (!found.value) return { learned: false, busy: false, code: 'PUBLISH_MONITOR_NOT_FOUND_YET', job: null };
    postId = found.value;
  }
  const rows = await listPostResults(deps, postId);
  if (rows.kind === 'rate_limited') return { learned: false, busy: true, code: 'PUBLISH_MONITOR_PROVIDER_BUSY', job: null };
  if (rows.kind !== 'ok') return { learned: false, busy: false, code: 'PUBLISH_MONITOR_CHECK_FAILED', job: null };
  const results: Record<string, { status: 'published' | 'failed'; url?: string }> = {};
  for (const target of targets) {
    const row = rows.value.find(result => result.socialAccountId === target.providerAccountId);
    if (row) results[target.connectionId] = row.success ? { status: 'published', ...(row.url ? { url: row.url } : {}) }
      : { status: 'failed' };
  }
  const job = await rpc(db, 'publish_monitor_publish_record', { p_job: jobId, p_provider_post_id: postId, p_results: results },
    jobView);
  const final = job.state === 'completed' || job.state === 'failed';
  return { learned: final, busy: false, code: 'PUBLISH_MONITOR_RESULT_PENDING', job };
}

const userCheck = z.object({ jobId: uuid, providerPostId: providerId.nullable(),
  targets: z.array(z.object({ connectionId: uuid, providerAccountId: providerId }).strict()) }).passthrough();

/** The user's own "check status" for one job; only jobs whose result is still open reach the provider. */
export async function refreshPublishJob(db: Rpc, deps: ClientDeps, profileId: string, jobId: string): Promise<PublishJob> {
  const job = await readPublishJob(db, profileId, jobId);
  if (job.state !== 'dispatching' && job.state !== 'unknown') return job;
  const open = await rpc(db, 'publish_monitor_publish_check_info', { a: profileId, p_job: jobId }, userCheck);
  const checked = await checkWithProvider(db, deps, jobId, open.providerPostId, open.targets);
  if (checked.busy) throw new PublishError('PUBLISH_MONITOR_PROVIDER_BUSY', 60);
  return checked.job ?? job;
}

export async function readPublishJob(db: Rpc, profileId: string, jobId: string): Promise<PublishJob> {
  return rpc(db, 'publish_monitor_publish_job', { a: uuid.parse(profileId), p_job: uuid.parse(jobId) }, jobView);
}

const reconcileItem = z.object({ jobId: uuid, lease: uuid, action: z.enum(['release', 'check']), externalId: uuid,
  providerPostId: providerId.nullable(), targets: z.array(z.object({ connectionId: uuid, providerAccountId: providerId })
    .strict()) }).strict();
export type ReconcileReport = { processed: number; settled: number; deferred: number; manual: number;
  stopped?: 'deadline' | 'provider_busy' };

/**
 * Daily job step: release expired claims and reconcile every dispatched job that has no final result yet.
 * On staging (Vercel Hobby) the job runs once a day, so results mostly arrive earlier through the provider webhook and
 * the user's own refresh; the 2-minute-to-4-hour backoff takes full effect once the job runs every 10 minutes after
 * the Vercel Pro upgrade (plan §8, REL-1).
 */
export async function reconcilePublishes(db: Rpc, deps: ClientDeps | null, until: number,
  now: () => number = Date.now): Promise<ReconcileReport> {
  const report: ReconcileReport = { processed: 0, settled: 0, deferred: 0, manual: 0 };
  // Drain batch after batch until nothing is due or the time budget ends: every handled job either settles, releases
  // its lease, or gets a later next_check_at, so a later claim never returns it again in the same run.
  for (let batch = 0; batch < MAX_BATCHES && now() < until; batch += 1) {
    // Without a provider key only expired claims are handed out: releasing them needs the database alone.
    const items = await rpc(db, 'publish_monitor_publish_reconcile_claim', { p_limit: BATCH, p_lease_seconds: 300,
      p_release_only: deps === null }, z.array(reconcileItem));
    for (const [index, item] of items.entries()) {
      // Out of time, or the shared provider budget is spent: hand the untried jobs back unchanged (no backoff step,
      // no move toward manual review) and stop; the next run or the user's refresh picks them up.
      const stop = now() >= until || (await reconcileOne(db, deps, item, report)) === 'busy';
      if (stop) {
        for (const rest of items.slice(index)) {
          await rpc(db, 'publish_monitor_publish_unlease', { p_job: rest.jobId, p_lease: rest.lease }, z.unknown());
        }
        report.stopped = now() >= until ? 'deadline' : 'provider_busy';
        return report;
      }
    }
    if (items.length < BATCH) break;
  }
  return report;
}

const BATCH = 50;
const MAX_BATCHES = 40;

async function reconcileOne(db: Rpc, deps: ClientDeps | null, item: z.infer<typeof reconcileItem>,
  report: ReconcileReport): Promise<'done' | 'busy'> {
  if (item.action === 'release') {
    report.processed += 1;
    await rpc(db, 'publish_monitor_publish_release', { p_job: item.jobId, p_code: 'PUBLISH_MONITOR_CLAIM_EXPIRED' }, jobView);
    report.settled += 1;
    return 'done';
  }
  if (!deps) return 'busy';
  const checked = await checkWithProvider(db, deps, item.jobId, item.providerPostId, item.targets);
  if (checked.busy) return 'busy';
  report.processed += 1;
  if (checked.learned) {
    report.settled += 1;
    await rpc(db, 'publish_monitor_publish_unlease', { p_job: item.jobId, p_lease: item.lease }, z.unknown());
    return 'done';
  }
  const later = await rpc(db, 'publish_monitor_publish_check_later', { p_job: item.jobId, p_lease: item.lease,
    p_code: checked.code }, jobView);
  if (later.manualReview) {
    report.manual += 1;
    logger.warn('api', 'publish_monitor_publish_manual_review', { jobId: item.jobId });
  } else report.deferred += 1;
  return 'done';
}

export const MAX_MEDIA = MAX_MEDIA_ITEMS;

/**
 * Upload slots for one post (1 to MAX_MEDIA files) in one request, requested only after the user confirmed the
 * disclosure (plan §2.1). One request per post keeps a complete post within the per-user step allowance.
 */
export async function createMediaUploads(deps: ClientDeps, count: number, pacing: Pacing = realPacing): Promise<UploadSlot[]> {
  if (!Number.isInteger(count) || count < 1 || count > MAX_MEDIA) throw new PublishError('PUBLISH_MONITOR_UNAVAILABLE');
  const slots: UploadSlot[] = [];
  for (let i = 0; i < count; i += 1) {
    const slot = await paced(pacing, () => createUploadUrl(deps));
    if (slot.kind !== 'ok') throw busy(slot);
    slots.push(slot.value);
  }
  return slots;
}
