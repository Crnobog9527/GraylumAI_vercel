/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getAccount, readFeedPage, type ClientDeps, type Outcome } from './postForMe/client';
import type { FeedPage, NormalizedPost } from './postForMe/normalize';

/**
 * PUBLISH-MONITOR PR-3a (plan §4.1 bounded refresh, §8 daily job): reads the user's own Post for Me posts into daily
 * snapshots. The database owns progress (lease, refresh number, cursor, daily page count); this layer reads one page at a
 * time and writes it before reading the next, so an interruption resumes after the last written page. Reading the
 * user's own data is free (Owner 2026-10-13): nothing here freezes or charges credits.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
type Db = Pick<SupabaseClient, 'rpc' | 'from'>;
type Clock = () => number;
const uuid = z.string().uuid();
export const PAGE_CAP_SETTING = 'publish_monitor_daily_page_cap';
export const DEFAULT_PAGE_CAP = 10;
export const JOB_LEASE_SECONDS = 300;
const DUE_BATCH = 20;
const DUE_LIMIT = 200;

export const claimSchema = z.object({
  connectionId: uuid, actorId: uuid, lease: uuid, refreshId: uuid, cursor: z.string().max(2048).nullable(),
  providerAccountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), platform: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  ownerRef: z.string().regex(/^[0-9a-f]{32}$/).nullable(), pagesUsed: z.number().int().min(0),
  knownPosts: z.number().int().min(0),
}).strict();
export type RefreshClaim = z.infer<typeof claimSchema>;

export type RefreshOutcome = 'done' | 'partial' | 'empty' | 'failed' | 'rejected' | 'taken_over' | 'entitlement'
  | 'release' | 'stale';
export type RefreshResult = { outcome: RefreshOutcome; pages: number; inserted: number; error: string | null };

export class RefreshError extends Error {
  constructor(readonly code: 'PUBLISH_MONITOR_REFRESH_UNAVAILABLE') { super(code); }
}

async function call<T>(db: Rpc, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const result = await db.rpc(name, args);
  if (result.error) throw new RefreshError('PUBLISH_MONITOR_REFRESH_UNAVAILABLE');
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new RefreshError('PUBLISH_MONITOR_REFRESH_UNAVAILABLE');
  return parsed.data;
}

/** Admin page cap per connection and day; a missing or malformed value falls back to the default. */
export async function readPageCap(db: Pick<SupabaseClient, 'from'>): Promise<number> {
  const { data, error } = await db.from('system_settings').select('value').eq('key', PAGE_CAP_SETTING).maybeSingle();
  const value = error ? null : data?.value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100 ? value : DEFAULT_PAGE_CAP;
}

const errorCode = (outcome: Exclude<Outcome<unknown>, { kind: 'ok' }>) => outcome.kind === 'rejected'
  ? `PROVIDER_REJECTED_${outcome.status}` : outcome.kind === 'unknown' ? 'PROVIDER_NO_ANSWER'
  : outcome.kind === 'failed' ? (outcome.status ? `PROVIDER_FAILED_${outcome.status}` : 'PROVIDER_RESPONSE_SHAPE')
  : 'PROVIDER_BUSY';

/** Which settle outcome a provider answer that is not ok leads to (plan §4.1: 5xx is "not fetched", never "deleted"). */
function outcomeFor(outcome: Exclude<Outcome<unknown>, { kind: 'ok' }>): Exclude<RefreshOutcome, 'stale'> {
  if (outcome.kind === 'rate_limited') return 'release';
  // Post for Me answers 500 for a missing account (measured), so only an explicit refusal of the grant (401/403) or a
  // missing account (404) asks the owner to re-authorise; other client errors (a stale cursor, a bad filter) are ours.
  if (outcome.kind === 'rejected') {
    if (outcome.status === 429) return 'release';
    return [401, 403, 404].includes(outcome.status) ? 'rejected' : 'failed';
  }
  return 'failed';
}

/** Below the database's 64 KiB limit per snapshot column (0272), with room for JSON encoding differences. */
const MAX_BREAKDOWN_BYTES = 48_000;
export const BREAKDOWNS_TRUNCATED = 'breakdowns.truncated';

/** A post's breakdowns larger than the database accepts are dropped and listed as missing, never failing the page. */
export function toRow(post: NormalizedPost) {
  const oversized = Buffer.byteLength(JSON.stringify(post.breakdowns)) > MAX_BREAKDOWN_BYTES;
  return { platformPostId: post.platformPostId, url: post.url, postedAt: post.postedAt, postedAtSource: post.postedAtSource,
    titleExcerpt: post.titleExcerpt, metrics: post.metrics, breakdowns: oversized ? {} : post.breakdowns,
    missingFields: oversized ? [...post.missingFields, BREAKDOWNS_TRUNCATED].sort() : post.missingFields };
}

const pageResult = z.union([
  z.object({ stale: z.literal(true) }).strict(),
  z.object({ stale: z.literal(false), inserted: z.number().int().min(0), existing: z.number().int().min(0) }).strict(),
]);

type Run = { db: Rpc; claim: RefreshClaim; pages: number; inserted: number };

/** Writes one page; false when the claim is no longer current (another worker, a webhook or a disconnect took over). */
async function write(run: Run, posts: NormalizedPost[], cursor: string | null, saveCursor: boolean) {
  const result = await call(run.db, 'publish_monitor_refresh_page', { p_connection_id: run.claim.connectionId,
    p_lease: run.claim.lease, p_refresh_id: run.claim.refreshId, p_posts: posts.map(toRow), p_cursor: cursor,
    p_save_cursor: saveCursor }, pageResult);
  run.pages += 1;
  if (result.stale) return null;
  run.inserted += result.inserted;
  return result;
}

async function settle(run: Run, outcome: Exclude<RefreshOutcome, 'stale'>, error: string | null = null): Promise<RefreshResult> {
  const current = await call(run.db, 'publish_monitor_refresh_finish', { p_connection_id: run.claim.connectionId,
    p_lease: run.claim.lease, p_refresh_id: run.claim.refreshId, p_outcome: outcome, p_error: error }, z.boolean());
  return { outcome: current ? outcome : 'stale', pages: run.pages, inserted: run.inserted, error };
}

const stale = (run: Run): RefreshResult => ({ outcome: 'stale', pages: run.pages, inserted: run.inserted, error: null });

/** Why reading stops early: a settle outcome with its error code, or a claim that is no longer ours. */
type Stop = { outcome: Exclude<RefreshOutcome, 'stale'>; error: string | null } | { outcome: 'stale' };

/**
 * The provider account must still carry the owner's reference (plan §4.1). Checked again after every feed read and
 * before its posts are written, so a re-authorisation by someone else mid-refresh never stores their posts here.
 */
async function ownership(client: ClientDeps, claim: RefreshClaim): Promise<Stop | null> {
  const account = await getAccount(client, claim.providerAccountId);
  if (account.kind !== 'ok') return { outcome: outcomeFor(account), error: errorCode(account) };
  if (account.value.status === 'disconnected') return { outcome: 'rejected', error: 'PROVIDER_DISCONNECTED' };
  if (account.value.externalId?.split('.')[0] !== claim.ownerRef) return { outcome: 'taken_over', error: null };
  return null;
}

/**
 * Refreshes one claimed connection within the owner's data window (days > 0; the caller checks the entitlement).
 * 1. The provider account must still carry the owner's reference, before the first read and after every read.
 * 2. Discovery: newest pages until a page holds an already known post, every dated post is older than the window, the
 *    provider has no more pages, or the daily page cap is reached. An interrupted discovery resumes from its cursor.
 * 3. Known posts due on their observation schedule are read by post ID in small batches. A platform that ignores the
 *    ID filter (its answer holds posts that were not asked for) is paged through instead, until every due post was
 *    seen, the feed ends or leaves the window, or the cap is reached (plan §4.1).
 * Every feed page counts against the daily cap, empty ones included. No new page starts after `until`; the lease is
 * then released with the cursor kept.
 */
export async function refreshConnection(db: Rpc, client: ClientDeps, claim: RefreshClaim, windowDays: number,
  pageCap: number, until: number, now: Clock = Date.now): Promise<RefreshResult> {
  const run: Run = { db, claim, pages: 0, inserted: 0 };
  if (!claim.ownerRef) return settle(run, 'failed', 'OWNER_REF_MISSING');
  if (now() >= until) return settle(run, 'release');
  const stop = (reason: Stop) => reason.outcome === 'stale' ? stale(run) : settle(run, reason.outcome, reason.error);

  const cutoff = now() - windowDays * 86_400_000;
  const inWindow = (post: NormalizedPost) => post.postedAt === null || Date.parse(post.postedAt) >= cutoff;
  let budget = pageCap - claim.pagesUsed;
  // Every provider call is bounded by what is left of the deadline, so a page started near the end cannot run past it
  // (the cron function and the manual request both have hard limits).
  const bounded = (): ClientDeps | null => {
    const left = until - now();
    return left < 1_000 ? null : { ...client, timeoutMs: Math.min(client.timeoutMs ?? 30_000, left) };
  };
  /**
   * One feed page read and confirmed as still the owner's; budget and deadline are checked first. Every read that
   * reached the provider is counted in the persistent daily cap at once (a failed read, or a page whose ownership
   * re-check failed, is recorded as an empty page); a page that passes is counted when its posts are written. The
   * shared limiter refusing a read means no provider call was made. A refused saved discovery cursor is cleared in the
   * same write, so it is never tried again.
   */
  const read = async (query: Parameters<typeof readFeedPage>[3], savedCursor = false)
    : Promise<FeedPage | Stop | 'rejected_cursor'> => {
    if (budget <= 0) return { outcome: 'partial', error: 'PAGE_CAP' };
    if (now() >= until) return { outcome: 'release', error: null };
    // Ownership is checked right before every feed request (plan §4.1), and again after it, before anything is stored.
    let deps = bounded();
    if (!deps) return { outcome: 'release', error: null };
    const before = await ownership(deps, claim);
    if (before) return before;
    deps = bounded();
    if (!deps) return { outcome: 'release', error: null };
    const page: Outcome<FeedPage> = await readFeedPage(deps, claim.providerAccountId, claim.platform, query);
    budget -= 1;
    if (page.kind === 'rate_limited') {
      // The provider's own 429 was a real request: it counts against the daily cap. A local refusal sent nothing.
      if (page.sent && !await write(run, [], null, false)) return { outcome: 'stale' };
      return { outcome: 'release', error: errorCode(page) };
    }
    if (page.kind !== 'ok') {
      const cursorRefused = Boolean(query?.cursor) && page.kind === 'rejected' && outcomeFor(page) === 'failed';
      if (!await write(run, [], null, cursorRefused && savedCursor)) return { outcome: 'stale' };
      return cursorRefused ? 'rejected_cursor' : { outcome: outcomeFor(page), error: errorCode(page) };
    }
    // The post-read check must still run (nothing is stored without it): give it at least a few seconds.
    const stopped = await ownership({ ...client, timeoutMs: Math.min(client.timeoutMs ?? 30_000, Math.max(5_000, until - now())) },
      claim);
    if (stopped) return await write(run, [], null, false) ? stopped : { outcome: 'stale' };
    return page.value;
  };
  const isPage = (value: FeedPage | Stop | 'rejected_cursor'): value is FeedPage => typeof value === 'object' && 'posts' in value;
  const scope = (posts: NormalizedPost[]) => {
    const dated = posts.filter(post => post.postedAt !== null);
    return { kept: posts.filter(inWindow), pastWindow: dated.length > 0 && dated.every(post => !inWindow(post)) };
  };

  let cursor = claim.cursor;
  let resuming = cursor !== null;
  let first = true;
  for (;;) {
    const page = await read({ cursor }, first && resuming);
    if (page === 'rejected_cursor' && first && resuming) {
      // A saved cursor the provider no longer accepts: start discovery again from the newest page.
      cursor = null;
      resuming = false;
      continue;
    }
    if (page === 'rejected_cursor') return settle(run, 'failed', 'PROVIDER_CURSOR_REJECTED');
    if (!isPage(page)) return stop(page);
    // An empty first page is never proof of "no posts" (plan §4.1); it is recorded (page count) and the database
    // applies the empty-list rules.
    if (first && !resuming && page.posts.length === 0 && page.rejected === 0) {
      if (!await write(run, [], null, false)) return stale(run);
      return settle(run, 'empty');
    }
    // Every entry unreadable (a provider schema change): counted, but never a success that resets the failure state.
    if (page.posts.length === 0 && page.rejected > 0) {
      if (!await write(run, [], null, false)) return stale(run);
      return settle(run, 'failed', 'PROVIDER_RESPONSE_SHAPE');
    }
    first = false;
    const { kept, pastWindow } = scope(page.posts);
    const more = page.hasMore && !pastWindow;
    const written = await write(run, kept, more ? page.nextCursor : null, true);
    if (!written) return stale(run);
    if (!more || written.existing > 0) break;
    cursor = page.nextCursor;
  }

  const due = await call(db, 'publish_monitor_refresh_due', { p_connection_id: claim.connectionId, p_lease: claim.lease,
    p_refresh_id: claim.refreshId, p_window_days: windowDays, p_limit: DUE_LIMIT }, z.array(z.string()).nullable());
  if (due === null) return stale(run);
  const waiting = new Set(due);
  for (let i = 0; i < due.length && waiting.size > 0; i += DUE_BATCH) {
    const asked = due.slice(i, i + DUE_BATCH).filter(id => waiting.has(id));
    if (asked.length === 0) continue;
    const askedSet = new Set(asked);
    let filtered = true;
    // A filtered answer can itself be paged (Facebook returns at most 10 posts with metrics): follow its cursor until
    // every asked post was seen. An answer holding posts that were not asked for means the filter was ignored.
    let next: string | null = null;
    for (let firstPage = true; firstPage || next !== null; firstPage = false) {
      const page = await read({ platformPostIds: asked, limit: DUE_BATCH, cursor: next });
      if (page === 'rejected_cursor') return settle(run, 'failed', 'PROVIDER_CURSOR_REJECTED');
      if (!isPage(page)) return stop(page);
      // Every entry unreadable: counted, settled as failed, never a success that skipped the due posts.
      if (page.posts.length === 0 && page.rejected > 0) {
        if (!await write(run, [], null, false)) return stale(run);
        return settle(run, 'failed', 'PROVIDER_RESPONSE_SHAPE');
      }
      filtered = page.posts.every(post => askedSet.has(post.platformPostId));
      if (!await write(run, scope(page.posts).kept, null, false)) return stale(run);
      for (const post of page.posts) waiting.delete(post.platformPostId);
      if (!filtered) { next = page.hasMore ? page.nextCursor : null; break; }
      next = asked.some(id => waiting.has(id)) && page.hasMore ? page.nextCursor : null;
    }
    if (filtered) continue;
    // The filter was ignored: page through the feed for the rest (cursor not saved; discovery owns the cursor).
    while (next !== null && waiting.size > 0) {
      const more = await read({ cursor: next });
      if (more === 'rejected_cursor') return settle(run, 'failed', 'PROVIDER_CURSOR_REJECTED');
      if (!isPage(more)) return stop(more);
      const { kept, pastWindow } = scope(more.posts);
      if (!await write(run, kept, null, false)) return stale(run);
      for (const post of more.posts) waiting.delete(post.platformPostId);
      next = more.hasMore && !pastWindow ? more.nextCursor : null;
    }
    break;
  }
  return settle(run, 'done');
}

export type WindowLookup = (actorId: string) => Promise<number>;
export type RefreshReport = { claimed: number; outcomes: Partial<Record<RefreshOutcome, number>> };

/**
 * Daily job step (plan §8): claims due connections in small batches and refreshes them one by one until the deadline.
 * A user whose plan has no data window is settled as "entitlement" without any provider call. A rate-limited read
 * releases its lease and ends this run's refresh step: the shared bucket is empty, later connections would fail too.
 */
export async function runRefresh(db: Db, client: ClientDeps, windowFor: WindowLookup, until: number,
  now: Clock = Date.now): Promise<RefreshReport> {
  const report: RefreshReport = { claimed: 0, outcomes: {} };
  const pageCap = await readPageCap(db);
  const windows = new Map<string, number>();
  while (now() < until) {
    const batch = await call(db, 'publish_monitor_refresh_claim', { p_limit: 10, p_lease_seconds: JOB_LEASE_SECONDS },
      z.array(claimSchema));
    if (batch.length === 0) break;
    report.claimed += batch.length;
    let stop = false;
    for (const claim of batch) {
      let result: RefreshResult;
      if (stop || now() >= until) {
        result = await settle({ db, claim, pages: 0, inserted: 0 }, 'release');
      } else {
        if (!windows.has(claim.actorId)) windows.set(claim.actorId, await windowFor(claim.actorId).catch(() => -1));
        const days = windows.get(claim.actorId)!;
        // -1: the entitlement could not be read; leave the connection for the next run instead of guessing.
        result = days < 0 ? await settle({ db, claim, pages: 0, inserted: 0 }, 'release')
          : days === 0 ? await settle({ db, claim, pages: 0, inserted: 0 }, 'entitlement')
          : await refreshConnection(db, client, claim, days, pageCap, until, now);
        // Rate limit, deadline or an unreadable entitlement: the next claim would hand the same rows back.
        if (result.outcome === 'release') stop = true;
      }
      report.outcomes[result.outcome] = (report.outcomes[result.outcome] ?? 0) + 1;
    }
    if (stop) break;
  }
  return report;
}

const PRUNE_BATCH = 20_000;

/** Retention (plan §7): removes snapshots older than 100 days in bounded batches until none are left or time runs out. */
export async function pruneSnapshots(db: Rpc, until: number, now: Clock = Date.now): Promise<number> {
  let total = 0;
  for (;;) {
    const removed = await call(db, 'publish_monitor_snapshot_prune', { p_limit: PRUNE_BATCH }, z.number().int().min(0));
    total += removed;
    if (removed < PRUNE_BATCH || now() >= until) return total;
  }
}
