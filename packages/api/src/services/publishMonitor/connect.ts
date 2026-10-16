/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createAuthUrl, getAccount, type AuthUrlInput, type ClientDeps, type PostForMePlatform } from './postForMe/client';

/**
 * PUBLISH-MONITOR connect flow (plan §4.1, migration 0246): start an attempt, record a callback with facts the
 * server fetched itself, and confirm the account the user picked. Routes and the confirmation page are PR-2b-2.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
const uuid = z.string().uuid();
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

// Brand accounts (opc_accounts.platform) are connectable only when their platform name is exactly the provider's,
// so the stored connection, the brand account and the provider record always agree without a translation table.
const PROVIDER_PLATFORMS: readonly PostForMePlatform[] = ['x', 'youtube', 'tiktok', 'tiktok_business', 'instagram',
  'facebook', 'threads', 'linkedin', 'pinterest', 'bluesky'];
export function providerPlatform(brandPlatform: string): PostForMePlatform | null {
  return (PROVIDER_PLATFORMS as readonly string[]).includes(brandPlatform) ? brandPlatform as PostForMePlatform : null;
}

export type ConnectErrorCode = 'PUBLISH_MONITOR_ACCOUNT_NOT_FOUND' | 'PUBLISH_MONITOR_PLATFORM_UNSUPPORTED'
  | 'PUBLISH_MONITOR_REQUEST_INVALID' | 'PUBLISH_MONITOR_ACCOUNT_OWNED_ELSEWHERE' | 'PUBLISH_MONITOR_ACCOUNT_BOUND_ELSEWHERE'
  | 'PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED' | 'PUBLISH_MONITOR_ACCOUNT_CLOSED' | 'PUBLISH_MONITOR_PROVIDER_BUSY'
  | 'PUBLISH_MONITOR_AUTHORIZATION_CHANGED' | 'PUBLISH_MONITOR_CALLBACK_STALE'
  | 'PUBLISH_MONITOR_PROVIDER_UNAVAILABLE' | 'PUBLISH_MONITOR_UNAVAILABLE';
export class ConnectError extends Error {
  constructor(readonly code: ConnectErrorCode, readonly retryAfterSeconds?: number) { super(code); }
}
const KNOWN: ConnectErrorCode[] = ['PUBLISH_MONITOR_ACCOUNT_NOT_FOUND', 'PUBLISH_MONITOR_REQUEST_INVALID',
  'PUBLISH_MONITOR_ACCOUNT_OWNED_ELSEWHERE', 'PUBLISH_MONITOR_ACCOUNT_BOUND_ELSEWHERE',
  'PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED', 'PUBLISH_MONITOR_ACCOUNT_CLOSED', 'PUBLISH_MONITOR_AUTHORIZATION_CHANGED',
  'PUBLISH_MONITOR_CALLBACK_STALE'];
function dbFailure(error: { message?: string } | null | undefined): ConnectError {
  return new ConnectError(KNOWN.find(code => error?.message?.includes(code)) ?? 'PUBLISH_MONITOR_UNAVAILABLE');
}

const startSchema = z.object({ requestId: uuid, externalId: z.string(), platform: z.string(),
  permissions: z.array(z.enum(['feeds', 'posts'])) }).strict();
const callbackSchema = z.object({ requestId: uuid, platform: z.string(), newAccounts: z.array(providerId),
  ownExisting: z.array(providerId), quarantined: z.array(providerId), ignored: z.array(providerId) }).strict();
const externalId = z.string().regex(/^[a-z0-9]{16,64}\.[a-z0-9]{16,64}$/);
const confirmSchema = z.object({ connectionId: uuid, externalId, unselected: z.array(providerId) }).strict();
const cancelSchema = z.object({ externalId, unselected: z.array(providerId) }).strict();
const pendingSchema = z.object({ requestId: uuid, platform: z.string(), permissions: z.array(z.enum(['feeds', 'posts'])),
  confirmExpiresAt: z.string(),
  target: z.object({ accountProjectId: uuid, platform: z.string(), accountKey: z.string(),
    businessName: z.string().nullable() }).strict(),
  candidates: z.array(z.object({ providerAccountId: providerId, kind: z.enum(['new', 'target', 'unavailable']) }).strict()),
}).strict();
export type PendingConnect = z.infer<typeof pendingSchema>;

export type StartInput = { accountProjectId: string; publish: boolean;
  connectionType?: AuthUrlInput['connectionType']; bluesky?: AuthUrlInput['bluesky'] };

/** Writes the attempt first (so a replayed or lost callback can always be matched), then asks for the link. */
export async function startConnect(db: Rpc, client: ClientDeps, profileId: string, input: StartInput) {
  const started = await db.rpc('publish_monitor_connect_start', { a: uuid.parse(profileId),
    p_account_project_id: uuid.parse(input.accountProjectId), p_permissions: input.publish ? ['feeds', 'posts'] : ['feeds'] });
  if (started.error) throw dbFailure(started.error);
  const attempt = startSchema.safeParse(started.data);
  if (!attempt.success) throw dbFailure(null);
  const platform = providerPlatform(attempt.data.platform);
  if (!platform) throw new ConnectError('PUBLISH_MONITOR_PLATFORM_UNSUPPORTED');
  const link = await createAuthUrl(client, { platform, externalId: attempt.data.externalId,
    permissions: attempt.data.permissions, forceReauth: input.publish, connectionType: input.connectionType,
    bluesky: input.bluesky });
  if (link.kind === 'rate_limited') throw new ConnectError('PUBLISH_MONITOR_PROVIDER_BUSY', link.retryAfterSeconds);
  if (link.kind !== 'ok') throw new ConnectError('PUBLISH_MONITOR_PROVIDER_UNAVAILABLE');
  return { requestId: attempt.data.requestId, ...link.value };
}

/**
 * Callback query parameters are only hints: every account is re-read from the provider and its current
 * external_id and platform are what the database compares (plan §4.1, principle 3).
 */
// One authorization can import several pages at once; the shared limiter allows only a few calls per second, so the
// callback waits out short throttles instead of failing (a retry would restart from the first account).
const CALLBACK_WAIT_BUDGET_MS = 20_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function recordCallback(db: Rpc, client: ClientDeps, profileId: string, requestId: string,
  hintedAccountIds: string[], wait: (ms: number) => Promise<unknown> = sleep) {
  const ids = [...new Set(hintedAccountIds)].filter(id => providerId.safeParse(id).success).slice(0, 200);
  const candidates: Array<{ providerAccountId: string; platform: string; externalId: string | null }> = [];
  let waited = 0;
  for (const id of ids) {
    let account = await getAccount(client, id);
    while (account.kind === 'rate_limited' && waited + account.retryAfterSeconds * 1000 <= CALLBACK_WAIT_BUDGET_MS) {
      waited += account.retryAfterSeconds * 1000;
      await wait(account.retryAfterSeconds * 1000);
      account = await getAccount(client, id);
    }
    if (account.kind === 'rate_limited') throw new ConnectError('PUBLISH_MONITOR_PROVIDER_BUSY', account.retryAfterSeconds);
    // Only "no such account" (404) is skipped; 401/403 means our key or access is broken, so stop before the
    // attempt is consumed and let the callback be retried.
    if (account.kind === 'rejected' && account.status === 404) continue;
    if (account.kind !== 'ok') throw new ConnectError('PUBLISH_MONITOR_PROVIDER_UNAVAILABLE');
    // A disconnected provider account has no usable authorization; it is never offered for confirmation.
    if (account.value.status !== 'connected') continue;
    candidates.push({ providerAccountId: account.value.id, platform: account.value.platform,
      externalId: account.value.externalId });
  }
  // Hints were supplied but none of them exists or is connected any more: not this attempt's callback (a late one of
  // an older attempt). Refuse without consuming the attempt; the older attempt's own cleanup settles its accounts.
  if (ids.length > 0 && candidates.length === 0) throw new ConnectError('PUBLISH_MONITOR_CALLBACK_STALE');
  const result = await db.rpc('publish_monitor_connect_callback', { a: uuid.parse(profileId),
    p_request_id: uuid.parse(requestId), p_candidates: candidates });
  if (result.error) throw dbFailure(result.error);
  const parsed = callbackSchema.safeParse(result.data);
  if (!parsed.success) throw dbFailure(null);
  // The provider facts each quarantine was decided on, so a later disconnect can check they still hold.
  const takenOver = parsed.data.quarantined.flatMap(id => {
    const fact = candidates.find(c => c.providerAccountId === id);
    return fact?.externalId ? [{ id, externalId: fact.externalId }] : [];
  });
  return { ...parsed.data, takenOver };
}

export async function confirmConnect(db: Rpc, client: ClientDeps, profileId: string, requestId: string,
  providerAccountId: string, autoTrack: boolean) {
  // Re-read just before applying: the database rejects the confirmation if the authorization moved since the callback.
  const account = await getAccount(client, providerId.parse(providerAccountId));
  if (account.kind === 'rate_limited') throw new ConnectError('PUBLISH_MONITOR_PROVIDER_BUSY', account.retryAfterSeconds);
  if (account.kind === 'rejected' && account.status === 404) throw new ConnectError('PUBLISH_MONITOR_AUTHORIZATION_CHANGED');
  if (account.kind !== 'ok') throw new ConnectError('PUBLISH_MONITOR_PROVIDER_UNAVAILABLE');
  const current = { providerAccountId: account.value.id, platform: account.value.platform,
    externalId: account.value.externalId, status: account.value.status };
  const result = await db.rpc('publish_monitor_connect_confirm', { a: uuid.parse(profileId),
    p_request_id: uuid.parse(requestId), p_provider_account_id: account.value.id, p_auto_track: autoTrack,
    p_current: current });
  if (result.error) throw dbFailure(result.error);
  const parsed = confirmSchema.safeParse(result.data);
  if (!parsed.success) throw dbFailure(null);
  return parsed.data;
}

/** The actor's own attempt waiting on the confirmation page; refused once applied, cancelled or expired. */
export async function readPending(db: Rpc, profileId: string, requestId: string): Promise<PendingConnect> {
  const result = await db.rpc('publish_monitor_connect_pending', { a: uuid.parse(profileId), p_request_id: uuid.parse(requestId) });
  if (result.error) throw dbFailure(result.error);
  const parsed = pendingSchema.safeParse(result.data);
  if (!parsed.success) throw dbFailure(null);
  return parsed.data;
}

/** The user declined. Nothing is bound; the attempt's new accounts come back for provider cleanup. */
export async function cancelConnect(db: Rpc, profileId: string, requestId: string) {
  const result = await db.rpc('publish_monitor_connect_cancel', { a: uuid.parse(profileId), p_request_id: uuid.parse(requestId) });
  if (result.error) throw dbFailure(result.error);
  const parsed = cancelSchema.safeParse(result.data);
  if (!parsed.success) throw dbFailure(null);
  return parsed.data;
}
