/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { getAccount, type ClientDeps, type Outcome } from './postForMe/client';
import { createPost, createUploadUrl, findPostByExternalId, listPostResults, type UploadSlot } from './postForMe/posts';

/**
 * PUBLISH-MONITOR PR-5 one-click publishing (plan §2.1, §6, §9 items 7/8/17/18; migration 0269).
 * The database owns every decision (idempotency, targets, slots, credits, states); this layer reads and writes
 * Post for Me. The caption and media URLs only pass through this request: nothing of them is stored or logged.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
const uuid = z.string().uuid();
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const MAX_CAPTION = 5000;
const media = z.object({
  // The public URL Post for Me returned with the upload slot; a retry must upload again (plan §2.1).
  mediaUrl: z.string().url().max(2048),
  // Identifies the file for the idempotency fingerprint, so a re-upload of the same file is the same request.
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive().max(5 * 1024 ** 3),
  mimeType: z.string().regex(/^(image|video)\/[a-z0-9.+-]{1,64}$/),
}).strict();

export const publishInput = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  businessId: uuid,
  workItemId: uuid.nullable(),
  connectionIds: z.array(uuid).min(1).max(9),
  caption: z.string().min(1).max(MAX_CAPTION),
  media: z.array(media).max(10),
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
  | 'PUBLISH_MONITOR_UNAVAILABLE';
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
    media: input.media.map(item => ({ sha256: item.sha256, size: item.size, mimeType: item.mimeType })),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

const claimed = jobView.and(z.object({ replayed: z.boolean(), quotaAlert: z.boolean().optional() }).passthrough());
const dispatched = jobView.and(z.object({ dispatch: z.boolean(),
  providerAccountIds: z.array(providerId).optional() }).passthrough());

const busy = (outcome: Outcome<unknown>) => new PublishError('PUBLISH_MONITOR_PROVIDER_BUSY',
  outcome.kind === 'rate_limited' ? outcome.retryAfterSeconds : 30);

/**
 * What Post for Me says about each target account right now (plan §4.1: check the owner before every publish).
 * A transient read failure stops here and leaves the job claimed, so the same request can try again.
 */
async function observeTargets(deps: ClientDeps, ids: string[]): Promise<Record<string, { ownerRef: string | null; connected: boolean }>> {
  const observed: Record<string, { ownerRef: string | null; connected: boolean }> = {};
  for (const id of ids) {
    const account = await getAccount(deps, id);
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
export async function submitPublish(db: Rpc, deps: ClientDeps, profileId: string, raw: PublishInput): Promise<PublishJob> {
  const input = publishInput.parse(raw);
  const job = await rpc(db, 'publish_monitor_publish_claim', { a: uuid.parse(profileId), p_key: input.idempotencyKey,
    p_fingerprint: publishFingerprint(input), p_business: input.businessId, p_work_item: input.workItemId,
    p_connections: input.connectionIds }, claimed);
  if (job.quotaAlert) logger.warn('api', 'publish_monitor_quota_80_percent', { jobId: job.id });
  if (job.state !== 'claimed') return job;
  const ids = await targetAccountIds(db, profileId, job.id);
  const observed = await observeTargets(deps, ids);
  // The slot for the create call is taken before the job is marked as possibly sent.
  const slot = await deps.limiter.acquire();
  if (!slot.ok) throw new PublishError('PUBLISH_MONITOR_PROVIDER_BUSY', slot.retryAfterSeconds);
  const ready = await rpc(db, 'publish_monitor_publish_dispatch', { a: profileId, p_job: job.id, p_observed: observed },
    dispatched);
  if (!ready.dispatch || !ready.providerAccountIds) return ready;
  const created = await createPost(deps, { externalId: job.id, caption: input.caption,
    socialAccountIds: ready.providerAccountIds, mediaUrls: input.media.map(item => item.mediaUrl) });
  if (created.kind === 'rejected') {
    return rpc(db, 'publish_monitor_publish_release', { p_job: job.id,
      p_code: `PUBLISH_MONITOR_PROVIDER_REJECTED_${created.status}` }, jobView);
  }
  if (created.kind === 'unknown') {
    logger.warn('api', 'publish_monitor_publish_unknown', { jobId: job.id, reason: created.reason });
    return rpc(db, 'publish_monitor_publish_unknown', { p_job: job.id, p_code: 'PUBLISH_MONITOR_RESULT_UNKNOWN' }, jobView);
  }
  return rpc(db, 'publish_monitor_publish_record', { p_job: job.id, p_provider_post_id: created.providerPostId,
    p_results: {} }, jobView);
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
  targets: ReconcileTarget[]): Promise<{ learned: boolean; code: string; job: PublishJob | null }> {
  let postId = providerPostId;
  if (!postId) {
    const found = await findPostByExternalId(deps, jobId);
    if (found.kind !== 'ok') return { learned: false, code: 'PUBLISH_MONITOR_CHECK_FAILED', job: null };
    if (!found.value) return { learned: false, code: 'PUBLISH_MONITOR_NOT_FOUND_YET', job: null };
    postId = found.value;
  }
  const rows = await listPostResults(deps, postId);
  if (rows.kind !== 'ok') return { learned: false, code: 'PUBLISH_MONITOR_CHECK_FAILED', job: null };
  const results: Record<string, { status: 'published' | 'failed'; url?: string }> = {};
  for (const target of targets) {
    const row = rows.value.find(result => result.socialAccountId === target.providerAccountId);
    if (row) results[target.connectionId] = row.success ? { status: 'published', ...(row.url ? { url: row.url } : {}) }
      : { status: 'failed' };
  }
  const job = await rpc(db, 'publish_monitor_publish_record', { p_job: jobId, p_provider_post_id: postId, p_results: results },
    jobView);
  const final = job.state === 'completed' || job.state === 'failed';
  return { learned: final, code: 'PUBLISH_MONITOR_RESULT_PENDING', job };
}

const userCheck = z.object({ jobId: uuid, providerPostId: providerId.nullable(),
  targets: z.array(z.object({ connectionId: uuid, providerAccountId: providerId }).strict()) }).passthrough();

/** The user's own "check status" for one job; only jobs whose result is still open reach the provider. */
export async function refreshPublishJob(db: Rpc, deps: ClientDeps, profileId: string, jobId: string): Promise<PublishJob> {
  const job = await readPublishJob(db, profileId, jobId);
  if (job.state !== 'dispatching' && job.state !== 'unknown') return job;
  const open = await rpc(db, 'publish_monitor_publish_check_info', { a: profileId, p_job: jobId }, userCheck);
  const checked = await checkWithProvider(db, deps, jobId, open.providerPostId, open.targets);
  return checked.job ?? job;
}

export async function readPublishJob(db: Rpc, profileId: string, jobId: string): Promise<PublishJob> {
  return rpc(db, 'publish_monitor_publish_job', { a: uuid.parse(profileId), p_job: uuid.parse(jobId) }, jobView);
}

const reconcileItem = z.object({ jobId: uuid, lease: uuid, action: z.enum(['release', 'check']), externalId: uuid,
  providerPostId: providerId.nullable(), targets: z.array(z.object({ connectionId: uuid, providerAccountId: providerId })
    .strict()) }).strict();
export type ReconcileReport = { processed: number; settled: number; deferred: number; manual: number };

/** Daily job step: release expired claims and reconcile every dispatched job that has no final result yet. */
export async function reconcilePublishes(db: Rpc, deps: ClientDeps, until: number,
  now: () => number = Date.now): Promise<ReconcileReport> {
  const report: ReconcileReport = { processed: 0, settled: 0, deferred: 0, manual: 0 };
  if (now() >= until) return report;
  const items = await rpc(db, 'publish_monitor_publish_reconcile_claim', { p_limit: 50, p_lease_seconds: 300 },
    z.array(reconcileItem));
  for (const item of items) {
    if (now() >= until) break;
    report.processed += 1;
    if (item.action === 'release') {
      await rpc(db, 'publish_monitor_publish_release', { p_job: item.jobId, p_code: 'PUBLISH_MONITOR_CLAIM_EXPIRED' }, jobView);
      report.settled += 1;
      continue;
    }
    const checked = await checkWithProvider(db, deps, item.jobId, item.providerPostId, item.targets);
    if (checked.learned) {
      report.settled += 1;
      await rpc(db, 'publish_monitor_publish_unlease', { p_job: item.jobId, p_lease: item.lease }, z.unknown());
      continue;
    }
    const later = await rpc(db, 'publish_monitor_publish_check_later', { p_job: item.jobId, p_lease: item.lease,
      p_code: checked.code }, jobView);
    if (later.manualReview) {
      report.manual += 1;
      logger.warn('api', 'publish_monitor_publish_manual_review', { jobId: item.jobId });
    } else report.deferred += 1;
  }
  return report;
}

/** An upload slot for the browser, requested only after the user confirmed the disclosure (plan §2.1). */
export async function createMediaUpload(deps: ClientDeps): Promise<UploadSlot> {
  const slot = await createUploadUrl(deps);
  if (slot.kind !== 'ok') throw busy(slot);
  return slot.value;
}
