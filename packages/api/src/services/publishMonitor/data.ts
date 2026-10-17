/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { readMembershipEntitlements } from '../membershipEntitlements';
import type { ClientDeps } from './postForMe/client';
import { claimSchema, readPageCap, refreshConnection, type RefreshOutcome, type WindowLookup } from './refresh';

/**
 * PUBLISH-MONITOR PR-3a (plan §4.1, §5.1, §9 items 4/20): the user's own post data inside their plan's window, a post's
 * daily trend, linking a post to a content item, and the hourly manual refresh. The window always comes from the
 * server-side entitlement, never from the page.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
type Db = Pick<SupabaseClient, 'rpc' | 'from'>;
const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).nullable();
const metrics = z.record(z.string(), z.number());
const MANUAL_LEASE_SECONDS = 120;
/** A manual refresh answers within the request: at most this long reading, then the lease is released. */
const MANUAL_BUDGET_MS = 25_000;

export type DataErrorCode = 'PUBLISH_MONITOR_ACCOUNT_CLOSED' | 'PUBLISH_MONITOR_CONNECTION_NOT_FOUND'
  | 'PUBLISH_MONITOR_POST_NOT_FOUND' | 'PUBLISH_MONITOR_WORK_ITEM_MISMATCH' | 'PUBLISH_MONITOR_REFRESH_UNAVAILABLE'
  | 'PUBLISH_MONITOR_REFRESH_TOO_SOON' | 'PUBLISH_MONITOR_REFRESH_RUNNING' | 'PUBLISH_MONITOR_UNAVAILABLE';
export class DataError extends Error {
  constructor(readonly code: DataErrorCode) { super(code); }
}
const KNOWN: DataErrorCode[] = ['PUBLISH_MONITOR_ACCOUNT_CLOSED', 'PUBLISH_MONITOR_CONNECTION_NOT_FOUND',
  'PUBLISH_MONITOR_POST_NOT_FOUND', 'PUBLISH_MONITOR_WORK_ITEM_MISMATCH', 'PUBLISH_MONITOR_REFRESH_UNAVAILABLE',
  'PUBLISH_MONITOR_REFRESH_TOO_SOON', 'PUBLISH_MONITOR_REFRESH_RUNNING'];

async function call<T>(db: Rpc, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const result = await db.rpc(name, args);
  if (result.error) {
    throw new DataError(KNOWN.find(code => result.error?.message?.includes(code)) ?? 'PUBLISH_MONITOR_UNAVAILABLE');
  }
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new DataError('PUBLISH_MONITOR_UNAVAILABLE');
  return parsed.data;
}

/** The owner's own-data window in days (0 = none). Used by the daily job, which must not trust anything else. */
export function entitlementWindow(client: SupabaseClient): WindowLookup {
  return async actorId => {
    try {
      return (await readMembershipEntitlements(client, actorId)).ownDataWindowDays;
    } catch (error) {
      // An account that is no longer usable has no window; anything else (a read failure) is left to the caller.
      if (error instanceof TRPCError && error.code === 'FORBIDDEN') return 0;
      throw error;
    }
  };
}

const snapshotSchema = z.object({ capturedOn: day, metrics, missingFields: z.array(z.string()),
  breakdowns: z.record(z.string(), z.unknown()) }).strict();
const dataSchema = z.object({
  windowDays: z.number().int().min(1),
  connections: z.array(z.object({ id: uuid, platform: z.string(), status: z.string(), lastSuccessAt: timestamp,
    refreshDay: day.nullable(), refreshState: z.string().nullable(), refreshError: z.string().nullable(),
    autoTrack: z.boolean(), delayed: z.boolean(), manualRefreshAt: timestamp }).strict()),
  posts: z.array(z.object({ id: uuid, connectionId: uuid, source: z.enum(['postforme', 'tikhub', 'manual']),
    url: z.string().nullable(), postedAt: timestamp, postedAtSource: z.enum(['provider', 'x_snowflake', 'user']).nullable(),
    firstSeenAt: z.string(), titleExcerpt: z.string().nullable(), workItemId: uuid.nullable(),
    latest: snapshotSchema.nullable() }).strict()),
}).strict();
export type PublishMonitorData = z.infer<typeof dataSchema>;

export const dataInput = z.object({ connectionId: uuid.optional() }).strict();
export function readData(db: Rpc, profileId: string, windowDays: number, input: z.infer<typeof dataInput>) {
  return call(db, 'publish_monitor_data', { a: uuid.parse(profileId), p_window_days: windowDays,
    p_connection_id: input.connectionId ?? null }, dataSchema);
}

export const historyInput = z.object({ postId: uuid }).strict();
const historySchema = z.object({ postId: uuid, snapshots: z.array(z.object({ capturedOn: day, metrics,
  missingFields: z.array(z.string()), source: z.enum(['postforme', 'tikhub', 'manual']) }).strict()) }).strict();
export function readPostHistory(db: Rpc, profileId: string, windowDays: number, input: z.infer<typeof historyInput>) {
  return call(db, 'publish_monitor_post_history', { a: uuid.parse(profileId), p_post_id: input.postId,
    p_window_days: windowDays }, historySchema);
}

export const linkInput = z.object({ postId: uuid, workItemId: uuid.nullable() }).strict();
export function linkPost(db: Rpc, profileId: string, input: z.infer<typeof linkInput>) {
  return call(db, 'publish_monitor_link_post', { a: uuid.parse(profileId), p_post_id: input.postId,
    p_work_item_id: input.workItemId }, z.object({ postId: uuid, workItemId: uuid.nullable() }).strict());
}

export const refreshInput = z.object({ connectionId: uuid }).strict();
export type ManualRefreshResult = { outcome: RefreshOutcome; inserted: number };

/**
 * The user's "refresh" button (plan §5.1): once an hour per connection, sharing the daily page cap and the site-wide
 * Post for Me bucket with the job. It answers within the request; anything left continues in the next daily run.
 */
export async function manualRefresh(db: Db, client: ClientDeps, profileId: string, windowDays: number,
  input: z.infer<typeof refreshInput>, now: () => number = Date.now): Promise<ManualRefreshResult> {
  const claim = await call(db, 'publish_monitor_refresh_request', { a: uuid.parse(profileId),
    p_connection_id: input.connectionId, p_lease_seconds: MANUAL_LEASE_SECONDS }, claimSchema);
  const pageCap = await readPageCap(db);
  const result = await refreshConnection(db, client, claim, windowDays, pageCap, now() + MANUAL_BUDGET_MS, now);
  return { outcome: result.outcome, inserted: result.inserted };
}
